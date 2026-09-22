import { describe, expect, it, vi } from "vitest";
import type { CoreConnection } from "./api.js";
import { CoreConnectionLoop, type CoreTransport } from "./connection-loop.js";

const oldCore: CoreConnection = { endpoint: "http://127.0.0.1:10001", adminToken: "old", generation: 1 };
const newCore: CoreConnection = { endpoint: "http://127.0.0.1:10002", adminToken: "new", generation: 2 };

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("desktop Core connection loop", () => {
  it("reads a matching authoritative snapshot before opening SSE and refreshes on notices", async () => {
    const order: string[] = [];
    const snapshots: Array<number | undefined> = [];
    let revision = 0;
    let notice: (() => void) | undefined;
    const transport: CoreTransport<{ revision: number }> = {
      connection: async () => { order.push("connection"); return oldCore; },
      snapshot: async () => { order.push("snapshot"); return { revision: ++revision }; },
      subscribe: async (_connection, onNotice, signal) => {
        order.push("subscribe"); notice = onNotice; await untilAbort(signal);
      },
    };
    const loop = new CoreConnectionLoop(transport, {
      snapshot: (value) => snapshots.push(value?.revision), error: () => undefined,
    });
    try {
      loop.start();
      await vi.waitFor(() => expect(notice).toBeDefined());
      expect(order.slice(0, 4)).toEqual(["connection", "snapshot", "connection", "subscribe"]);
      expect(snapshots).toEqual([1]);
      notice!(); // Includes the initial SSE snapshot event, which closes the subscribe gap.
      await vi.waitFor(() => expect(snapshots).toEqual([1, 2]));
    } finally { await loop.stop(); }
  });

  it("retries every SSE end with snapshot before each new subscription", async () => {
    const order: string[] = [];
    let streams = 0;
    const transport: CoreTransport<number> = {
      connection: async () => { order.push("connection"); return oldCore; },
      snapshot: async () => { order.push("snapshot"); return streams; },
      subscribe: async (_connection, _notice, signal) => {
        order.push("subscribe"); streams += 1;
        if (streams < 3) return;
        await untilAbort(signal);
      },
    };
    const loop = new CoreConnectionLoop(transport, {
      snapshot: () => undefined, error: () => undefined,
    });
    try {
      loop.start();
      await vi.waitFor(() => expect(streams).toBe(3), { timeout: 3_000 });
      expect(order).toEqual([
        "connection", "snapshot", "connection", "subscribe",
        "connection", "snapshot", "connection", "subscribe",
        "connection", "snapshot", "connection", "subscribe",
      ]);
    } finally { await loop.stop(); }
  });

  it("recovers from startup failures and establishes a snapshot before SSE", async () => {
    let connectionAttempts = 0;
    let subscriptions = 0;
    const snapshots: number[] = [];
    const errors: Array<string | undefined> = [];
    const transport: CoreTransport<number> = {
      connection: async () => {
        connectionAttempts += 1;
        if (connectionAttempts <= 2) throw new Error("untrusted-startup-detail");
        return oldCore;
      },
      snapshot: async () => 7,
      subscribe: async (_connection, _notice, signal) => {
        subscriptions += 1;
        await untilAbort(signal);
      },
    };
    const loop = new CoreConnectionLoop(transport, {
      snapshot: (value) => { if (value !== undefined) snapshots.push(value); },
      error: (value) => errors.push(value),
    });
    try {
      loop.start();
      await vi.waitFor(() => expect(subscriptions).toBe(1), { timeout: 3_000 });
      expect(snapshots).toEqual([7]);
      expect(errors).toContain("Core connection unavailable");
      expect(errors).not.toContain("untrusted-startup-detail");
    } finally { await loop.stop(); }
  });

  it("discards a late snapshot from the prior Core generation", async () => {
    const snapshots: number[] = [];
    let resolveOld: ((value: number) => void) | undefined;
    let connectionCalls = 0;
    const transport: CoreTransport<number> = {
      connection: async () => (++connectionCalls === 1 ? oldCore : newCore),
      snapshot: async (connection) => connection.generation === 1
        ? await new Promise<number>((resolve) => { resolveOld = resolve; }) : 2,
      subscribe: async (_connection, _notice, signal) => await untilAbort(signal),
    };
    const loop = new CoreConnectionLoop(transport, {
      snapshot: (value) => { if (value !== undefined) snapshots.push(value); },
      error: () => undefined,
    });
    try {
      loop.start();
      await vi.waitFor(() => expect(resolveOld).toBeDefined());
      loop.reconnectNow();
      resolveOld!(1);
      await vi.waitFor(() => expect(snapshots).toEqual([2]));
    } finally { await loop.stop(); }
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

interface ProbeRequest {
  deliveryId: string;
  channel: string;
  actionKind: string;
  action: { name: string; params: Record<string, unknown> } | null;
  projectionRevision?: number;
  receivedAt: number;
}

interface DeliveryState {
  action_kind: string;
  projection_revision: number | null;
  status: string;
  last_error: string | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class HttpDeliveryProbe {
  readonly requests: ProbeRequest[] = [];
  readonly #heldChannels = new Set<string>();
  readonly #server: Server;
  #url = "";

  private constructor() {
    this.#server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        deliveryId: string;
        channel: string;
        actionKind: string;
        action: ProbeRequest["action"];
        projectionRevision?: number;
      };
      this.requests.push({ ...payload, receivedAt: Date.now() });
      if (this.#heldChannels.delete(payload.channel)) return;
      response.writeHead(204).end();
    });
  }

  static async start(): Promise<HttpDeliveryProbe> {
    const probe = new HttpDeliveryProbe();
    await new Promise<void>((resolve, reject) => {
      probe.#server.once("error", reject);
      probe.#server.listen(0, "127.0.0.1", () => {
        probe.#server.off("error", reject);
        resolve();
      });
    });
    const address = probe.#server.address() as AddressInfo;
    probe.#url = `http://127.0.0.1:${address.port}/delivery`;
    return probe;
  }

  get url(): string {
    return this.#url;
  }

  holdNext(channel: string): void {
    this.#heldChannels.add(channel);
  }

  async waitFor(
    channel: string,
    parameter: string,
    value: string,
    startIndex = 0,
    timeoutMs = 5_000,
  ): Promise<ProbeRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const match = this.requests.slice(startIndex).find(
        (request) => request.channel === channel && request.action?.params[parameter] === value,
      );
      if (match) return match;
      await delay(10);
    }
    throw new Error(`Timed out waiting for ${channel}:${parameter}=${value}`);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function readDeliveries(databasePath: string, commandId: string): DeliveryState[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(
      `SELECT action_kind, projection_revision, status, last_error
       FROM deliveries WHERE command_id = ? ORDER BY action_kind`,
    ).all(commandId) as DeliveryState[];
  } finally {
    database.close();
  }
}

function statefulBinding(id: string, signalId: string, resourceChannel: string): Binding {
  return {
    id,
    name: id,
    enabled: true,
    selector: { producerId: "delivery-recovery", signalId, scopePattern: "*" },
    conditions: [],
    mapping: { phase: { kind: "pointer", pointer: "/phase" } },
    target: {
      driverInstanceId: "http-delivery",
      resourceChannel,
      actionKind: "stateful",
      actionName: "project",
    },
  };
}

function eventBinding(
  id: string,
  resourceChannel: string,
  actionKind: "queued-effect" | "append-only",
): Binding {
  return {
    id,
    name: id,
    enabled: true,
    selector: { producerId: "delivery-effects", eventType: "delivery.test", scopePattern: "*" },
    conditions: [],
    mapping: { sequence: { kind: "pointer", pointer: "/sequence" } },
    target: {
      driverInstanceId: "http-delivery",
      resourceChannel,
      actionKind,
      actionName: actionKind === "queued-effect" ? "send" : "append",
    },
    batchWindowMs: 700,
  };
}

describe("crash-safe delivery recovery", () => {
  it("reclaims the current lease, replays a delivered projection, and pre-dispatch fences stale revision", async () => {
    const probe = await HttpDeliveryProbe.start();
    const harness = await CoreAcceptanceHarness.start({ deliveryLeaseMs: 600 });
    try {
      const producer = await harness.admin.createProducer("delivery-recovery");
      const config = {
        bindings: [
          statefulBinding("lease-reclaim", "lease-reclaim", "lease-reclaim"),
          statefulBinding("revision-guard", "revision-guard", "revision-guard"),
        ],
        driverInstances: [{
          id: "http-delivery",
          driverType: "http",
          enabled: true,
          config: { baseUrl: probe.url, allowPrivateNetwork: true, timeoutMs: 5_000 },
        }],
      };
      await harness.admin.publishConfig(config);

      probe.holdNext("lease-reclaim");
      const leased = await producer.upsertClaim("scope", "lease-reclaim", { value: { phase: "leased" } });
      expect(leased.response.status).toBe(202);
      expect((await producer.command(leased.body.commandId)).status).toBe("applied");
      const firstLease = await probe.waitFor("lease-reclaim", "phase", "leased");
      expect(firstLease.projectionRevision).toBeTypeOf("number");
      await harness.crash();

      const reclaimStart = probe.requests.length;
      await harness.restart();
      const reclaimed = await probe.waitFor("lease-reclaim", "phase", "leased", reclaimStart);
      expect(reclaimed.projectionRevision).toBe(firstLease.projectionRevision);
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "expired stateful lease to be reclaimed" });

      const replayStart = probe.requests.length;
      await harness.crash();
      await harness.restart();
      const replayed = await probe.waitFor("lease-reclaim", "phase", "leased", replayStart);
      expect(replayed.projectionRevision).toBe(firstLease.projectionRevision);
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "delivered current projection to replay after restart" });

      const driverRestartStart = probe.requests.length;
      await harness.admin.publishConfig(config);
      const driverReplayed = await probe.waitFor("lease-reclaim", "phase", "leased", driverRestartStart);
      expect(driverReplayed.projectionRevision).toBe(firstLease.projectionRevision);
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "current projection to replay after driver configuration restart" });

      probe.holdNext("revision-guard");
      const older = await producer.upsertClaim("scope", "revision-guard", { value: { phase: "older" } });
      const olderRequest = await probe.waitFor("revision-guard", "phase", "older");
      const newer = await producer.upsertClaim("scope", "revision-guard", { value: { phase: "newer" } });
      expect((await producer.command(newer.body.commandId)).status).toBe("applied");
      expect((await harness.admin.snapshot()).projections).toContainEqual(expect.objectContaining({
        resourceChannel: "revision-guard",
        action: { name: "project", params: { phase: "newer" } },
      }));
      await harness.crash();

      const revisionRestart = probe.requests.length;
      await harness.restart();
      const newerRequest = await probe.waitFor("revision-guard", "phase", "newer", revisionRestart);
      expect(newerRequest.projectionRevision).toBeGreaterThan(olderRequest.projectionRevision ?? 0);
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "stale stateful lease to be suppressed after expiry" });
      expect(probe.requests.slice(revisionRestart).filter((request) => request.channel === "revision-guard"))
        .toEqual([expect.objectContaining({
          action: { name: "project", params: { phase: "newer" } },
          projectionRevision: newerRequest.projectionRevision,
        })]);
      expect(readDeliveries(harness.paths.database, older.body.commandId)).toContainEqual(expect.objectContaining({
        action_kind: "stateful",
        projection_revision: olderRequest.projectionRevision,
        status: "suppressed",
      }));
      expect(readDeliveries(harness.paths.database, newer.body.commandId)).toContainEqual(expect.objectContaining({
        action_kind: "stateful",
        projection_revision: newerRequest.projectionRevision,
        status: "delivered",
      }));
    } finally {
      await harness.dispose();
      await probe.close();
    }
  }, 30_000);

  it("suppresses queued effects across recovery, recovers append-only, and never replays paused events", async () => {
    const probe = await HttpDeliveryProbe.start();
    const harness = await CoreAcceptanceHarness.start({ deliveryLeaseMs: 600 });
    try {
      const producer = await harness.admin.createProducer("delivery-effects");
      await harness.admin.publishConfig({
        bindings: [
          eventBinding("queued", "queued-channel", "queued-effect"),
          eventBinding("append", "append-channel", "append-only"),
        ],
        driverInstances: [{
          id: "http-delivery",
          driverType: "http",
          enabled: true,
          config: { baseUrl: probe.url, allowPrivateNetwork: true, timeoutMs: 5_000 },
        }],
      });

      const committed = await producer.emitEvent({
        eventId: "before-crash",
        type: "delivery.test",
        value: { sequence: "before-crash" },
      });
      expect(committed.response.status).toBe(202);
      expect((await producer.command(committed.body.commandId)).status).toBe("applied");
      await harness.crash();

      const recoveryStart = probe.requests.length;
      await harness.restart();
      await probe.waitFor("append-channel", "sequence", "before-crash", recoveryStart);
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "recovered action-kind deliveries to settle" });
      expect(readDeliveries(harness.paths.database, committed.body.commandId)).toEqual([
        expect.objectContaining({ action_kind: "append-only", status: "delivered" }),
        expect.objectContaining({
          action_kind: "queued-effect",
          status: "suppressed",
          last_error: "Queued effect crossed a Core recovery boundary",
        }),
      ]);
      expect(probe.requests.slice(recoveryStart).map((request) => request.channel)).toEqual(["append-channel"]);

      const pauseStart = probe.requests.length;
      const backlog = await producer.emitEvent({
        eventId: "pause-backlog",
        type: "delivery.test",
        value: { sequence: "pause-backlog" },
      });
      expect((await producer.command(backlog.body.commandId)).status).toBe("applied");
      await harness.admin.setPaused(true);
      const paused = await producer.emitEvent({
        eventId: "while-paused",
        type: "delivery.test",
        value: { sequence: "while-paused" },
      });
      expect((await producer.command(paused.body.commandId)).status).toBe("applied");
      expect((await harness.admin.snapshot()).pendingDeliveries).toBe(0);
      expect(readDeliveries(harness.paths.database, backlog.body.commandId)).toEqual([
        expect.objectContaining({ action_kind: "append-only", status: "suppressed" }),
        expect.objectContaining({ action_kind: "queued-effect", status: "suppressed" }),
      ]);
      expect(readDeliveries(harness.paths.database, paused.body.commandId)).toEqual([]);
      await harness.crash();

      await harness.restart();
      expect((await harness.admin.snapshot()).outputsPaused).toBe(true);
      await harness.admin.setPaused(false);
      await delay(900);
      expect((await harness.admin.snapshot()).pendingDeliveries).toBe(0);
      expect(probe.requests.slice(pauseStart).some((request) =>
        ["pause-backlog", "while-paused"].includes(String(request.action?.params.sequence)),
      )).toBe(false);
      expect(readDeliveries(harness.paths.database, backlog.body.commandId).every(
        (delivery) => delivery.status === "suppressed",
      )).toBe(true);
      expect(readDeliveries(harness.paths.database, paused.body.commandId)).toEqual([]);
    } finally {
      await harness.dispose();
      await probe.close();
    }
  }, 30_000);
});

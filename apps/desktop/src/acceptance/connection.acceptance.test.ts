import { describe, expect, it, vi } from "vitest";
import { CoreAcceptanceHarness } from "../../../core/src/acceptance/harness.js";
import { fetchSnapshot, subscribe, type CoreConnection, type RuntimeSnapshot } from "../api.js";
import { CoreConnectionLoop, type CoreTransport } from "../connection-loop.js";

describe("desktop connection against the real Core", () => {
  it("closes the snapshot-to-SSE gap and reconnects from a fresh snapshot after Core crashes", async () => {
    const harness = await CoreAcceptanceHarness.start();
    const producer = await harness.admin.createProducer("desktop-connection-test");
    const seen: Array<{ generation: number; claims: number }> = [];
    let generation = 1;
    let snapshotReads = 0;
    let subscriptions = 0;
    let lastError: string | undefined;
    const transport: CoreTransport<RuntimeSnapshot> = {
      connection: async (): Promise<CoreConnection> => ({
        endpoint: `http://${harness.discovery.host}:${harness.discovery.port}`,
        adminToken: harness.adminToken, generation,
      }),
      snapshot: async (connection, signal) => {
        const baseline = await fetchSnapshot(connection, signal);
        snapshotReads += 1;
        if (snapshotReads === 1) {
          // A claim committed after the HTTP snapshot but before SSE subscription.
          const result = await producer.upsertClaim("scope", "status", {
            value: { phase: "active" }, urgency: "informational",
          });
          expect(result.response.status).toBe(202);
        }
        return baseline;
      },
      subscribe: async (connection, onNotice, signal) => {
        subscriptions += 1;
        await subscribe(connection, onNotice, signal);
      },
    };
    const loop = new CoreConnectionLoop(transport, {
      snapshot: (value) => {
        if (value) seen.push({ generation, claims: value.claims.length });
      },
      error: (message) => { lastError = message; },
    });
    try {
      loop.start();
      await vi.waitFor(() => expect(seen).toContainEqual({ generation: 1, claims: 1 }),
        { timeout: 5_000 });
      expect(seen[0]).toEqual({ generation: 1, claims: 0 });
      expect(subscriptions).toBe(1);
      await harness.crash();
      await vi.waitFor(() => expect(lastError).toBe("Core connection unavailable"),
        { timeout: 5_000 });
      generation = 2;
      await harness.restart();
      loop.reconnectNow();
      await vi.waitFor(() => expect(seen).toContainEqual({ generation: 2, claims: 1 }),
        { timeout: 5_000 });
      expect(subscriptions).toBeGreaterThanOrEqual(2);
    } finally {
      await loop.stop();
      await harness.dispose();
    }
  }, 30_000);
  it("exits a supervised Core when the parent command pipe closes", async () => {
    const harness = await CoreAcceptanceHarness.start({ supervisedStdin: true });
    try {
      const oldPid = harness.processId;
      expect((await harness.fetch("/health/live")).status).toBe(200);
      await harness.disconnectSupervisorStdin();
      expect(harness.isRunning).toBe(false);
      await harness.restart();
      expect(harness.processId).not.toBe(oldPid);
      expect((await harness.fetch("/health/live")).status).toBe(200);
    } finally {
      await harness.dispose();
    }
  }, 20_000);

});

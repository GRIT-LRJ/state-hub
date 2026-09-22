import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("config publish versus an in-flight stateful driver", () => {
  it("finishes the old call before activating a same-ID driver and delivers the current projection to the new target", async () => {
    let releaseOld: () => void = () => undefined;
    let markOldStarted: () => void = () => undefined;
    const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
    let oldCalls = 0;
    let newCalls = 0;
    const oldServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      oldCalls++;
      markOldStarted();
      await new Promise<void>((resolve) => { releaseOld = resolve; });
      response.writeHead(204).end();
    });
    const newServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      newCalls++;
      response.writeHead(204).end();
    });
    const oldOrigin = await listen(oldServer);
    const newOrigin = await listen(newServer);
    const harness = await CoreAcceptanceHarness.start();
    const binding: Binding = {
      id: "current", name: "current", enabled: true,
      selector: { producerId: "inflight-producer", signalId: "status", scopePattern: "*" },
      conditions: [], mapping: { phase: { kind: "pointer", pointer: "/phase" } },
      target: { driverInstanceId: "same-id", resourceChannel: "light",
        actionKind: "stateful", actionName: "project" },
    };
    const config = (origin: string) => ({
      bindings: [binding], driverInstances: [{ id: "same-id", driverType: "http", enabled: true,
        config: { baseUrl: origin + "/project", privateTargetOrigin: origin, timeoutMs: 10_000 } }],
    });
    try {
      const producer = await harness.admin.createProducer("inflight-producer");
      await harness.admin.publishConfig(config(oldOrigin));
      expect((await producer.upsertClaim("scope", "status", { value: { phase: "working" } })).response.status)
        .toBe(202);
      await oldStarted;
      const publishing = harness.admin.publishConfig(config(newOrigin));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await harness.fetch("/api/v1/admin/config/export", {
        headers: { authorization: "Bearer " + harness.adminToken },
      });
      expect(((await current.json()) as { config: { driverInstances: Array<{ config: { baseUrl: string } }> } })
        .config.driverInstances[0]?.config.baseUrl).toBe(oldOrigin + "/project");
      expect(newCalls).toBe(0);
      releaseOld();
      await publishing;
      await harness.waitFor(() => newCalls === 1, {
        timeoutMs: 10_000, description: "current projection at updated target",
      });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);
      expect(oldCalls).toBe(1);
      expect(newCalls).toBe(1);
    } finally {
      releaseOld();
      await harness.dispose();
      await close(oldServer);
      await close(newServer);
    }
  }, 30_000);
});

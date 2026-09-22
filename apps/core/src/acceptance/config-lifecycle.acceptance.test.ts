import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

async function receiver(): Promise<{ server: Server; origin: string; received: string[] }> {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventId: string }).eventId);
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("configuration lifecycle through real Core management APIs", () => {
  it("switches a same-ID driver to its new config, recomputes current state and rolls back without replaying events", async () => {
    const first = await receiver();
    const second = await receiver();
    const harness = await CoreAcceptanceHarness.start();
    const append: Binding = {
      id: "append", name: "append", enabled: true,
      selector: { producerId: "config-producer", eventType: "notice", scopePattern: "*" },
      conditions: [], mapping: { value: { kind: "pointer", pointer: "/value" } },
      target: { driverInstanceId: "same-id", resourceChannel: "notices",
        actionKind: "append-only", actionName: "append" },
    };
    const stateful: Binding = {
      id: "current", name: "current", enabled: true,
      selector: { producerId: "config-producer", signalId: "status", scopePattern: "*" },
      conditions: [], mapping: { color: { kind: "constant", value: "green" } },
      target: { driverInstanceId: "virtual-main", resourceChannel: "light",
        actionKind: "stateful", actionName: "render" },
    };
    const config = (origin: string, includeStateful = false) => ({
      bindings: includeStateful ? [append, stateful] : [append],
      driverInstances: [
        { id: "same-id", driverType: "http", enabled: true,
          config: { baseUrl: origin + "/append", privateTargetOrigin: origin } },
        { id: "virtual-main", driverType: "official.virtual", enabled: true, config: {} },
      ],
    });
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init, headers: { authorization: "Bearer " + harness.adminToken, ...init.headers },
    });
    try {
      const producer = await harness.admin.createProducer("config-producer");
      const originalRevision = await harness.admin.publishConfig(config(first.origin));
      expect((await producer.emitEvent({ eventId: "before", type: "notice", value: { value: 1 } })).response.status)
        .toBe(202);
      await harness.waitFor(() => first.received.length === 1, { description: "first HTTP target" });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);
      expect((await producer.upsertClaim("scope", "status", { value: { phase: "working" } })).response.status)
        .toBe(202);
      const events = await harness.observeEvents();
      const updatedRevision = await harness.admin.publishConfig(config(second.origin, true));
      expect(updatedRevision).toBeGreaterThan(originalRevision);
      const rendered = await events.waitFor("virtual.rendered");
      expect(rendered.data).toMatchObject({ action: { name: "render", params: { color: "green" } } });
      const snapshot = await harness.admin.snapshot();
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceChannel: "light", action: { name: "render", params: { color: "green" } },
      }));
      expect(first.received).toEqual(["before"]);
      expect(second.received).toEqual([]);
      const unsafeRemoval = config(second.origin);
      unsafeRemoval.driverInstances.pop();
      const removalDraft = await admin("/api/v1/admin/config/drafts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(unsafeRemoval),
      });
      expect(removalDraft.status).toBe(201);
      const removalRevision = (await removalDraft.json() as { revision: number }).revision;
      const prematureRemoval = await admin(`/api/v1/admin/config/drafts/${removalRevision}/publish`,
        { method: "POST" });
      expect(prematureRemoval.status).toBe(409);
      expect((await prematureRemoval.json() as { error: { code: string } }).error.code)
        .toBe("CONFIG_ACTIVE_OUTPUT");
      expect((await producer.emitEvent({ eventId: "after", type: "notice", value: { value: 2 } })).response.status)
        .toBe(202);
      await harness.waitFor(() => second.received.length === 1, { description: "updated HTTP target" });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);
      expect(first.received).toEqual(["before"]);
      expect(second.received).toEqual(["after"]);
      await harness.crash();
      await harness.restart();
      expect(first.received).toEqual(["before"]);
      expect(second.received).toEqual(["after"]);
      expect((await harness.admin.snapshot()).projections).toContainEqual(expect.objectContaining({
        resourceChannel: "light", action: { name: "render", params: { color: "green" } },
      }));

      const rollback = await admin(`/api/v1/admin/config/revisions/${originalRevision}/rollback`, {
        method: "POST",
      });
      expect(rollback.status).toBe(201);
      const draft = await rollback.json() as { revision: number; impact: Record<string, unknown> };
      expect(draft.revision).toBeGreaterThan(updatedRevision);
      expect(draft.impact).toMatchObject({ bindingsRemoved: ["current"], historicalEventsReplayed: 0 });
      const publish = await admin(`/api/v1/admin/config/drafts/${draft.revision}/publish`, { method: "POST" });
      expect(publish.status).toBe(200);
      expect(first.received).toEqual(["before"]);
      expect(second.received).toEqual(["after"]);
      expect((await producer.emitEvent({ eventId: "after-rollback", type: "notice", value: { value: 3 } })).response.status)
        .toBe(202);
      await harness.waitFor(() => first.received.length === 2, { description: "rolled back HTTP target" });
      expect(first.received).toEqual(["before", "after-rollback"]);
    } finally {
      await harness.dispose();
      await close(first.server);
      await close(second.server);
    }
  }, 30_000);
});

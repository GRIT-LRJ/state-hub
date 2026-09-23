import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "../../../core/src/acceptance/harness.js";
import type { CoreConnection } from "../api.js";
import {
  loadConfigCatalog, loadConfigRevisions, loadManagedConfig, previewManagedConfig,
  previewRollback, publishManagedConfig, type ManagedConfig,
} from "../config-management.js";

describe("desktop configuration client against the real Core", () => {
  it("rejects invalid config, previews and publishes, then rolls back without replaying old events", async () => {
    const received: string[] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventId: string }).eventId);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    const harness = await CoreAcceptanceHarness.start();
    const connection: CoreConnection = {
      endpoint: `http://${harness.discovery.host}:${harness.discovery.port}`,
      adminToken: harness.adminToken, generation: 1,
    };
    try {
      expect((await loadConfigCatalog(connection)).driverDefinitions.map((entry) => entry.id))
        .toContain("official.virtual");
      expect(await loadManagedConfig(connection)).toMatchObject({ driverInstances: [{ id: "virtual-main" }], bindings: [] });
      const invalid: ManagedConfig = { driverInstances: [{
        id: "bad-virtual", driverType: "virtual", enabled: true, config: { unknown: true },
      }], bindings: [] };
      await expect(previewManagedConfig(invalid, connection)).rejects.toThrow("INVALID_DRIVER_CONFIG");
      expect(await loadConfigRevisions(undefined, connection)).toEqual([]);

      const producer = await harness.admin.createProducer("desktop-config-source", "official.custom-http");
      const config: ManagedConfig = {
        driverInstances: [{ id: "http-main", driverType: "http", enabled: true,
          config: { baseUrl: `${origin}/events`, privateTargetOrigin: origin } }],
        bindings: [{
          id: "event-to-http", name: "Event to HTTP", enabled: true,
          selector: { producerId: "desktop-config-source", eventType: "custom", scopePattern: "*" },
          conditions: [], mapping: { content: { kind: "pointer", pointer: "/content" } },
          target: { driverInstanceId: "http-main", resourceChannel: "events",
            actionKind: "append-only", actionName: "append" },
        }],
      };
      const first = await previewManagedConfig(config, connection);
      expect(first.impact).toMatchObject({ bindingsAdded: ["event-to-http"], historicalEventsReplayed: 0 });
      await publishManagedConfig(first.revision, connection);
      expect((await loadManagedConfig(connection)).bindings).toHaveLength(1);

      const sent = await producer.emitEvent({ eventId: "history-once", type: "custom",
        value: { content: "first event" } });
      expect(sent.response.status).toBe(202);
      await harness.waitFor(async () => received.length === 1 &&
        (await harness.admin.snapshot()).pendingDeliveries === 0);
      expect(received).toEqual(["history-once"]);

      const empty = await previewManagedConfig({ driverInstances: [], bindings: [] }, connection);
      await publishManagedConfig(empty.revision, connection);
      const rollback = await previewRollback(first.revision, connection);
      expect(rollback).toMatchObject({ rolledBackFrom: first.revision,
        impact: { historicalEventsReplayed: 0 } });
      expect(rollback.revision).toBeGreaterThan(empty.revision);
      await publishManagedConfig(rollback.revision, connection);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(received).toEqual(["history-once"]);

      const fresh = await producer.emitEvent({ eventId: "new-event", type: "custom",
        value: { content: "second event" } });
      expect(fresh.response.status).toBe(202);
      await harness.waitFor(async () => received.length === 2);
      expect(received).toEqual(["history-once", "new-event"]);
      expect((await loadConfigRevisions(undefined, connection)).map((row) =>
        [row.revision, row.status])).toEqual([
        [rollback.revision, "published"], [empty.revision, "superseded"],
        [first.revision, "superseded"],
      ]);
    } finally {
      await harness.dispose();
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  }, 30_000);
});

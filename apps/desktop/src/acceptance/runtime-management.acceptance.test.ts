import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "../../../core/src/acceptance/harness.js";
import { setOutputsPaused, type CoreConnection } from "../api.js";
import {
  acknowledgeClaim, fetchSupportBundle, loadDiagnosticPreview,
} from "../runtime-management.js";

function stateful(id: string, scopePattern: string, honorAcknowledgement: boolean): Binding {
  return {
    id, name: id, enabled: true,
    selector: { producerId: "runtime-source", scopePattern, signalId: "status" },
    conditions: [], mapping: { phase: { kind: "pointer", pointer: "/phase" } },
    target: { driverInstanceId: "virtual-main", resourceChannel: id,
      actionKind: "stateful", actionName: "render" },
    honorAcknowledgement,
  };
}

describe("desktop runtime management against the real Core", () => {
  it("fences acknowledgement by identity and revision, pauses safely, and previews redacted export", async () => {
    let httpInvocations = 0;
    const receiver = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the request */ }
      httpInvocations += 1;
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
      const producer = await harness.admin.createProducer("runtime-source");
      await harness.admin.publishConfig({
        driverInstances: [
          { id: "virtual-main", driverType: "virtual", enabled: true, config: {} },
          { id: "http-events", driverType: "http", enabled: true,
            config: { baseUrl: `${origin}/events`, privateTargetOrigin: origin } },
        ],
        bindings: [
          stateful("alpha-honor", "alpha", true),
          stateful("alpha-ignore", "alpha", false),
          stateful("beta-honor", "beta", true),
          { id: "event-http", name: "Event HTTP", enabled: true,
            selector: { producerId: "runtime-source", eventType: "custom" },
            conditions: [], mapping: { content: { kind: "pointer", pointer: "/content" } },
            target: { driverInstanceId: "http-events", resourceChannel: "events",
              actionKind: "append-only", actionName: "append" } },
        ],
      });
      expect((await producer.upsertClaim("alpha", "status", {
        value: { phase: "first" },
      })).response.status).toBe(202);
      expect((await producer.upsertClaim("beta", "status", {
        value: { phase: "second" },
      })).response.status).toBe(202);
      const projection = async (channel: string) =>
        (await harness.admin.snapshot()).projections.find((item) => item.resourceChannel === channel);
      await harness.waitFor(async () => (await projection("alpha-honor"))?.action?.params.phase === "first" &&
        (await projection("beta-honor"))?.action?.params.phase === "second");

      const old = (await harness.admin.snapshot()).claims.find((item) => item.scopeId === "alpha")!;
      await acknowledgeClaim(old, connection);
      await harness.waitFor(async () => (await projection("alpha-honor"))?.action === null);
      expect((await projection("alpha-ignore"))?.action?.params.phase).toBe("first");
      expect((await projection("beta-honor"))?.action?.params.phase).toBe("second");

      expect((await producer.upsertClaim("alpha", "status", {
        value: { phase: "third" },
      })).response.status).toBe(202);
      await expect(acknowledgeClaim(old, connection)).rejects.toThrow("CLAIM_REVISION_MISMATCH");
      await harness.waitFor(async () => (await projection("alpha-honor"))?.action?.params.phase === "third");
      const fresh = (await harness.admin.snapshot()).claims.find((item) => item.scopeId === "alpha")!;
      expect(fresh.revision).toBeGreaterThan(old.revision);
      await acknowledgeClaim(fresh, connection);
      await harness.waitFor(async () => (await projection("alpha-honor"))?.action === null);
      expect((await projection("beta-honor"))?.action?.params.phase).toBe("second");

      await setOutputsPaused(true, connection);
      expect((await harness.admin.snapshot()).outputsPaused).toBe(true);
      expect((await projection("alpha-ignore"))?.action).toBeNull();
      expect((await projection("beta-honor"))?.action).toBeNull();
      const sensitive = "person@example.test";
      expect((await producer.upsertClaim("alpha", "status", {
        value: { phase: sensitive },
      })).response.status).toBe(202);
      expect((await producer.emitEvent({ eventId: "event-during-pause",
        type: "custom", value: { content: "private body" } })).response.status).toBe(202);
      expect((await harness.admin.snapshot()).claims.find((item) => item.scopeId === "alpha")
        ?.value).toEqual({ phase: sensitive });
      await setOutputsPaused(false, connection);
      await harness.waitFor(async () => (await projection("alpha-honor"))?.action?.params.phase === sensitive);
      expect((await projection("alpha-ignore"))?.action?.params.phase).toBe(sensitive);
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);
      expect(httpInvocations).toBe(0);

      const preview = await loadDiagnosticPreview(connection);
      expect(preview.files).toEqual([{ name: "state-hub-support-bundle.json", containsSecrets: false }]);
      expect(preview.redaction.join(" ")).toContain("claim and action values");
      const bundle = await fetchSupportBundle(connection);
      expect(JSON.parse(bundle)).toMatchObject({ schemaVersion: 1 });
      expect(bundle).not.toContain(sensitive);
      expect(bundle).not.toContain("private body");
      expect(bundle).not.toContain(producer.token);

      expect((await producer.emitEvent({ eventId: "fresh-event",
        type: "custom", value: { content: "new body" } })).response.status).toBe(202);
      await harness.waitFor(async () => httpInvocations === 1);
      expect(httpInvocations).toBe(1);
    } finally {
      await harness.dispose();
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  }, 30_000);
});

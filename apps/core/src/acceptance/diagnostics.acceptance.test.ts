import Database from "better-sqlite3";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

describe("support bundle privacy boundary", () => {
  it("previews redaction and excludes mapped claim values and legacy free text from the exported API", async () => {
    const harness = await CoreAcceptanceHarness.start();
    const secrets = [
      "Authorization: Bearer support-token-123",
      "Cookie: sid=support-cookie-456",
      "password=support-password-789",
      "credentialRef=support-credential-012",
      "person@example.test",
      "+15551234567",
    ];
    try {
      const producer = await harness.admin.createProducer("support");
      const binding: Binding = {
        id: "support-binding",
        name: secrets[2]!,
        enabled: true,
        selector: { producerId: "support", signalId: "status", scopePattern: "*" },
        conditions: [],
        mapping: {
          phase: { kind: "pointer", pointer: "/phase" },
          message: { kind: "pointer", pointer: "/message" },
          content: { kind: "pointer", pointer: "/content" },
          turnId: { kind: "pointer", pointer: "/turnId" },
          headers: { kind: "constant", value: { Authorization: secrets[0], Cookie: secrets[1] } },
        },
        target: {
          driverInstanceId: "virtual-main",
          resourceChannel: "support-status",
          actionKind: "stateful",
          actionName: "render",
        },
      };
      await harness.admin.publishConfig({
        bindings: [binding],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      const claim = await producer.upsertClaim("scope", "status", {
        value: {
          phase: secrets[0],
          message: secrets[1],
          content: secrets[4],
          turnId: secrets[5],
          nested: { credentialRef: secrets[3] },
        },
      });
      expect(claim.response.status).toBe(202);
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);

      const database = new Database(harness.paths.database);
      try {
        database.pragma("busy_timeout = 5000");
        database.prepare(
          "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
        ).run(secrets[0], secrets[1], JSON.stringify({ headers: { Cookie: secrets[1] }, body: secrets[4] }), secrets[5]);
        database.prepare(
          `INSERT INTO deliveries(
             id, command_id, producer_id, event_id, driver_instance_id, resource_channel,
             action_kind, action_json, batch_id, status, attempt_count, available_at,
             deadline_at, last_error, created_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dead-letter', 1, ?, ?, ?, ?, ?)`,
        ).run(
          secrets[0], secrets[1], secrets[2], secrets[3], secrets[4], secrets[5],
          secrets[0], JSON.stringify({ content: secrets[4] }), secrets[1],
          new Date().toISOString(), secrets[2], secrets[3], secrets[4], secrets[5],
        );
      } finally {
        database.close();
      }

      const preview = await harness.admin.diagnosticsPreview();
      expect(preview.files.map((file) => file.name)).toEqual(["state-hub-support-bundle.json"]);
      expect(preview.redaction.join(" ")).toContain("claim and action values");

      const exportResponse = await harness.admin.diagnosticsExportResponse();
      expect(exportResponse.headers.get("content-disposition")).toContain(preview.files[0]!.name);
      const serialized = await exportResponse.text();
      const bundle = JSON.parse(serialized) as Record<string, unknown>;
      for (const secret of secrets) expect(serialized).not.toContain(secret);
      expect(bundle.runtime).toMatchObject({ claimCount: 1, projections: expect.any(Array) });
      expect(bundle.deliveries).toContainEqual(expect.objectContaining({
        deliveryId: expect.stringMatching(/^sha256:/u),
        commandId: expect.stringMatching(/^sha256:/u),
        actionKind: "other",
        lastError: "Driver error details withheld",
        deadlineAt: null,
        createdAt: null,
      }));
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});

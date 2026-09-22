import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StateHubDatabase } from "./database.js";
import { PluginRepository } from "./plugin-repository.js";

describe("plugin uninstall recovery references", () => {
  it("protects pending delivery from an older config after its instance was removed", () => {
    const db = new StateHubDatabase(":memory:");
    try {
      db.raw.prepare(`INSERT INTO plugin_packages(
        id, version, publisher_id, signed, manifest_json, source_definitions_json,
        driver_definitions_json, archive_sha256, archive_blob, installed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "community.legacy", "1.0.0", "legacy", 1, "{}", "[]",
        JSON.stringify([{ id: "community.legacy.driver" }]), "hash", Buffer.from("archive"),
        "2026-01-01T00:00:00.000Z",
      );
      db.raw.prepare(`INSERT INTO config_revisions(
        revision, status, config_json, impact_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`).run(
        1, "superseded", JSON.stringify({
          driverInstances: [{ id: "legacy-instance", driverType: "community.legacy.driver" }],
          bindings: [],
        }), "{}", "2026-01-01T00:00:00.000Z",
      );
      db.raw.prepare(`INSERT INTO deliveries(
        id, driver_instance_id, resource_channel, action_kind, action_json,
        status, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "pending-old", "legacy-instance", "audit", "append-only", "{}",
        "pending", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      );
      const repository = new PluginRepository(db);
      const identity = `sha256:${createHash("sha256").update("pending-old").digest("hex")}`;
      expect(repository.dependencies("community.legacy").deliveries).toEqual([identity]);
      expect(() => repository.uninstall("community.legacy")).toThrow("pending deliveries");
      expect(repository.installed().map((plugin) => plugin.id)).toEqual(["community.legacy"]);
      db.raw.prepare("UPDATE deliveries SET status = 'dead-letter' WHERE id = 'pending-old'").run();
      repository.uninstall("community.legacy");
      expect(repository.installed()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

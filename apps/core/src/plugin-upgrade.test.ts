import type { DriverDefinition } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { StateHubDatabase } from "./database.js";
import { PluginRepository, type PluginUpgradeCandidate } from "./plugin-repository.js";
import { migratedUpgradeConfig } from "./plugin-upgrade.js";
import type { PublishedConfig } from "./service.js";

const driver: DriverDefinition = {
  id: "community.test.driver", version: "2.0.0", displayNameKey: "test.driver",
  configSchema: { type: "object" },
  actions: { emit: { kind: "append-only", paramsSchema: {
    type: "object", required: ["next"], properties: { next: { type: "boolean" } },
  } } },
};

function candidate(): PluginUpgradeCandidate {
  return {
    oldDriverDefinitionIds: [driver.id], oldSourceDefinitionIds: [],
    driverDefinitions: [driver], sourceDefinitions: [],
  } as unknown as PluginUpgradeCandidate;
}

describe("plugin upgrade compatibility", () => {
  it("rejects a new action contract that would strand an unfinished delivery", () => {
    const db = new StateHubDatabase(":memory:");
    try {
      db.raw.prepare(
        `INSERT INTO deliveries(id, driver_instance_id, resource_channel, action_kind,
           action_json, status, available_at, created_at)
         VALUES ('queued', 'own', 'feed', 'append-only', ?, 'pending', ?, ?)`,
      ).run(JSON.stringify({ name: "emit", params: {} }), new Date().toISOString(), new Date().toISOString());
      const config: PublishedConfig = { bindings: [], driverInstances: [
        { id: "own", driverType: driver.id, enabled: true, config: {} },
      ] };
      expect(() => migratedUpgradeConfig(db, new PluginRepository(db), candidate(), config,
        { driverInstances: [{ id: "own", config: {} }] })).toThrowError(
        expect.objectContaining({ code: "PLUGIN_DELIVERY_INCOMPATIBLE" }),
      );
    } finally { db.close(); }
  });

  it("rejects a migration result that tries to rewrite another plugin's instance", () => {
    const db = new StateHubDatabase(":memory:");
    try {
      const config: PublishedConfig = { bindings: [], driverInstances: [
        { id: "own", driverType: driver.id, enabled: true, config: {} },
        { id: "foreign", driverType: "virtual", enabled: true, config: {} },
      ] };
      expect(() => migratedUpgradeConfig(db, new PluginRepository(db), candidate(), config,
        { driverInstances: [{ id: "foreign", config: { stolen: true } }] })).toThrowError(
        expect.objectContaining({ code: "PLUGIN_MIGRATION_RESULT" }),
      );
    } finally { db.close(); }
  });
});

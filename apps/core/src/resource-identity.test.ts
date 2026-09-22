import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resourceKey } from "@state-hub/domain";
import { describe, expect, it } from "vitest";
import { StateHubDatabase } from "./database.js";

describe("persisted resource identity", () => {
  it("transactionally upgrades an existing projection key and keeps its revision across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "state-hub-resource-"));
    const path = join(directory, "core.sqlite");
    const driverInstanceId = "virtual";
    const resourceChannel = "status";
    const legacyKey = [driverInstanceId, resourceChannel].join(String.fromCharCode(31));
    let database: StateHubDatabase | undefined;
    try {
      database = new StateHubDatabase(path);
      database.raw.prepare(
        `INSERT INTO projections(
           resource_key, driver_instance_id, resource_channel, action_json, urgency,
           contributors_json, revision, updated_at
         ) VALUES (?, ?, ?, ?, 'ambient', '{"bindingIds":[],"claimKeys":[]}', 17, ?)`,
      ).run(legacyKey, driverInstanceId, resourceChannel, '{"name":"render","params":{"phase":"working"}}', "2026-09-01T00:00:00.000Z");
      database.close();
      database = new StateHubDatabase(path);
      expect(database.raw.prepare("SELECT resource_key, revision FROM projections").get()).toEqual({
        resource_key: resourceKey(driverInstanceId, resourceChannel),
        revision: 17,
      });
      database.close();
      database = new StateHubDatabase(path);
      expect(database.raw.prepare("SELECT resource_key, revision FROM projections").get()).toEqual({
        resource_key: resourceKey(driverInstanceId, resourceChannel),
        revision: 17,
      });
    } finally {
      database?.close();
      const resolvedDirectory = resolve(directory);
      if (!resolvedDirectory.startsWith(resolve(tmpdir()) + sep)) {
        throw new Error("Refusing to remove a directory outside the temporary root");
      }
      rmSync(resolvedDirectory, { recursive: true, force: true });
    }
  });
});

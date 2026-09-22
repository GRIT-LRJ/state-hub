import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateHubDatabase } from "./database.js";
import { HubEventBus } from "./events.js";
import { RetentionService } from "./retention.js";
import { StateHubService } from "./service.js";

describe("persistent dedupe identities", () => {
  it("backfills existing command/event rows and retains their identities after payload cleanup", () => {
    const directory = mkdtempSync(join(tmpdir(), "state-hub-dedupe-"));
    const path = join(directory, "core.sqlite");
    let database: StateHubDatabase | undefined;
    try {
      database = new StateHubDatabase(path);
      database.raw.prepare(
        `INSERT INTO commands(
           id, producer_id, kind, idempotency_key, request_hash, status, accepted_at, completed_at
         ) VALUES ('legacy-command', 'producer', 'event.emit', 'legacy-key', 'digest', 'applied', ?, ?)`,
      ).run("2026-09-07T00:00:00.000Z", "2026-09-07T00:00:00.000Z");
      database.raw.prepare(
        `INSERT INTO occurrence_events(
           producer_id, event_id, type, value_json, urgency, revision, accepted_at
         ) VALUES ('producer', 'legacy-event', 'test.event', ?, 'ambient', 1, ?)`,
      ).run(JSON.stringify({ payload: "removable" }), "2026-09-07T00:00:00.000Z");
      database.close();
      database = new StateHubDatabase(path);

      expect(database.raw.prepare("SELECT key_hash FROM command_dedupe").get())
        .toEqual({ key_hash: expect.not.stringMatching("legacy-key") });
      expect(database.raw.prepare("SELECT event_id_hash FROM event_dedupe").get())
        .toEqual({ event_id_hash: expect.not.stringMatching("legacy-event") });
      const now = new Date("2026-09-07T12:00:00.000Z");
      const ageReport = new RetentionService(database, { maxAgeMs: 60_000 }).run(now);
      expect(ageReport.removed.commands).toBe(1);
      expect(ageReport.removed.events).toBe(1);
      expect(database.raw.prepare("SELECT count(*) AS count FROM commands").get()).toEqual({ count: 0 });
      expect(database.raw.prepare("SELECT count(*) AS count FROM occurrence_events").get()).toEqual({ count: 0 });
      expect(database.raw.prepare("SELECT count(*) AS count FROM command_dedupe").get()).toEqual({ count: 1 });
      expect(database.raw.prepare("SELECT count(*) AS count FROM event_dedupe").get()).toEqual({ count: 1 });
      const report = new RetentionService(database, { maxBytes: 1 }).run(now);
      expect(report.protectedBytesOverBudget).toBeGreaterThan(0);
      expect(new StateHubService(database, new HubEventBus()).getCommand("producer", "legacy-command"))
        .toMatchObject({ commandId: "legacy-command", status: "applied" });
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

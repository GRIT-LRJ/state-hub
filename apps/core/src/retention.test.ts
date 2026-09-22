import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateHubDatabase } from "./database.js";
import { RetentionService } from "./retention.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const old = "2026-08-01T00:00:00.000Z";
const recent = "2026-09-07T11:00:00.000Z";

function insertCommand(db: StateHubDatabase, id: string, completedAt: string, payload = ""): void {
  db.raw.prepare(
    `INSERT INTO commands(
       id, producer_id, kind, idempotency_key, request_hash, status,
       accepted_at, completed_at, error_code, error_message
     ) VALUES (?, 'producer', 'event.emit', ?, ?, 'applied', ?, ?, NULL, ?)`,
  ).run(id, `key-${id}`, "hash", completedAt, completedAt, payload || null);
}

function insertEvent(db: StateHubDatabase, eventId: string, acceptedAt: string, payload = ""): void {
  db.raw.prepare(
    `INSERT INTO occurrence_events(
       producer_id, event_id, type, scope_id, source_type, value_json, urgency,
       occurred_at, metadata_json, revision, accepted_at
     ) VALUES ('producer', ?, 'test.event', 'scope', NULL, ?, 'ambient', NULL, NULL, 1, ?)`,
  ).run(eventId, JSON.stringify({ payload }), acceptedAt);
}

function insertDelivery(
  db: StateHubDatabase,
  values: {
    id: string;
    commandId?: string;
    eventId?: string;
    status: "pending" | "leased" | "delivered";
    timestamp: string;
    payload?: string;
    attemptDetail?: string;
  },
): void {
  const completedAt = values.status === "delivered" ? values.timestamp : null;
  db.raw.prepare(
    `INSERT INTO deliveries(
       id, command_id, producer_id, event_id, event_revision,
       driver_instance_id, resource_channel, action_kind, action_json,
       projection_revision, status, attempt_count, available_at, created_at, completed_at
     ) VALUES (?, ?, 'producer', ?, 1, 'virtual-main', 'audit', 'append-only', ?,
               NULL, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.commandId ?? null,
    values.eventId ?? null,
    JSON.stringify({ name: "append", params: { payload: values.payload ?? "" } }),
    values.status,
    values.attemptDetail ? 1 : 0,
    values.timestamp,
    values.timestamp,
    completedAt,
  );
  if (values.attemptDetail) {
    db.raw.prepare(
      `INSERT INTO delivery_attempts(
         delivery_id, attempt, started_at, completed_at, status, detail
       ) VALUES (?, 1, ?, ?, 'retry', ?)`,
    ).run(values.id, values.timestamp, values.timestamp, values.attemptDetail);
  }
}

function count(db: StateHubDatabase, table: string): number {
  return (db.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("historical data retention", () => {
  let db: StateHubDatabase;

  beforeEach(() => {
    db = new StateHubDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("removes every expired terminal history class and preserves unfinished recovery state", () => {
    db.raw.prepare(
      `INSERT INTO claims(
         producer_id, scope_id, signal_id, value_json, urgency, stale_policy, revision, updated_at
       ) VALUES ('producer', 'scope', 'status', '{}', 'ambient', 'retain', 10, ?)`,
    ).run(old);
    db.raw.prepare(
      `INSERT INTO projections(
         resource_key, driver_instance_id, resource_channel, action_json, urgency,
         contributors_json, revision, updated_at
       ) VALUES ('virtual-main:status', 'virtual-main', 'status', '{}', 'ambient',
                 '{"bindingIds":[],"claimKeys":[]}', 7, ?)`,
    ).run(old);
    db.raw.prepare(
      `INSERT INTO config_revisions(
         revision, status, config_json, impact_json, created_at, published_at
       ) VALUES (1, 'published', '{"bindings":[],"driverInstances":[]}', '{}', ?, ?)`,
    ).run(old, old);

    insertCommand(db, "expired-command", old);
    insertEvent(db, "expired-event", old);
    insertDelivery(db, {
      id: "expired-delivery",
      commandId: "expired-command",
      eventId: "expired-event",
      status: "delivered",
      timestamp: old,
      attemptDetail: "expired attempt",
    });
    db.raw.prepare(
      "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES ('expired', NULL, '{}', ?)",
    ).run(old);

    insertCommand(db, "protected-command", old);
    insertEvent(db, "protected-event", old);
    insertDelivery(db, {
      id: "protected-delivery",
      commandId: "protected-command",
      eventId: "protected-event",
      status: "pending",
      timestamp: old,
      attemptDetail: "retry audit required for recovery",
    });
    db.raw.prepare(
      "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES ('recent', NULL, '{}', ?)",
    ).run(recent);

    const retention = new RetentionService(db);
    const report = retention.run(now);

    expect(report.removed).toEqual({ history: 1, events: 1, deliveries: 1, attempts: 1, commands: 1 });
    expect(db.raw.prepare("SELECT id FROM deliveries").all()).toEqual([{ id: "protected-delivery" }]);
    expect(db.raw.prepare("SELECT event_id FROM occurrence_events").all()).toEqual([{ event_id: "protected-event" }]);
    expect(db.raw.prepare("SELECT id FROM commands").all()).toEqual([{ id: "protected-command" }]);
    expect(count(db, "delivery_attempts")).toBe(1);
    expect(count(db, "claims")).toBe(1);
    expect(count(db, "projections")).toBe(1);
    expect(count(db, "config_revisions")).toBe(1);
    expect(db.raw.pragma("foreign_key_check")).toEqual([]);

    expect(retention.run(now).removed).toEqual({
      history: 0,
      events: 0,
      deliveries: 0,
      attempts: 0,
      commands: 0,
    });
  });

  it("counts UTF-8 payloads across every history class and removes globally oldest eligible data", () => {
    db.raw.prepare(
      "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES ('oldest', NULL, ?, '2026-09-01T00:00:00.000Z')",
    ).run(JSON.stringify({ payload: "界".repeat(100) }));
    insertCommand(db, "old-command", "2026-09-02T00:00:00.000Z", "c".repeat(300));
    insertEvent(db, "old-event", "2026-09-03T00:00:00.000Z", "e".repeat(300));
    insertDelivery(db, {
      id: "old-delivery",
      status: "delivered",
      timestamp: "2026-09-04T00:00:00.000Z",
      payload: "d".repeat(300),
      attemptDetail: "a".repeat(300),
    });
    db.raw.prepare(
      "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES ('newest', NULL, ?, '2026-09-05T00:00:00.000Z')",
    ).run(JSON.stringify({ payload: "n".repeat(500) }));

    const retention = new RetentionService(db, { maxAgeMs: 365 * 24 * 60 * 60 * 1000, maxBytes: 700 });
    const measured = retention.measure();
    expect(measured.history).toBeGreaterThan(800);
    expect(measured.events).toBeGreaterThan(300);
    expect(measured.deliveries).toBeGreaterThan(300);
    expect(measured.attempts).toBeGreaterThan(300);
    expect(measured.commands).toBeGreaterThan(300);

    const report = retention.run(now);
    expect(report.after.total).toBeLessThanOrEqual(700);
    expect(report.protectedBytesOverBudget).toBe(0);
    expect(db.raw.prepare("SELECT kind FROM history").all()).toEqual([{ kind: "newest" }]);
    expect(count(db, "occurrence_events")).toBe(0);
    expect(count(db, "deliveries")).toBe(0);
    expect(count(db, "delivery_attempts")).toBe(0);
    expect(count(db, "commands")).toBe(0);
    expect(db.raw.pragma("foreign_key_check")).toEqual([]);
  });

  it("reports an unavoidable overage instead of deleting a pending delivery or its references", () => {
    insertCommand(db, "pending-command", recent, "command payload");
    insertEvent(db, "pending-event", recent, "event payload");
    insertDelivery(db, {
      id: "pending-delivery",
      commandId: "pending-command",
      eventId: "pending-event",
      status: "leased",
      timestamp: recent,
      payload: "delivery payload",
      attemptDetail: "retry detail",
    });

    const retention = new RetentionService(db, { maxBytes: 1 });
    const report = retention.run(now);

    expect(report.after.total).toBe(report.before.total);
    expect(report.protectedBytesOverBudget).toBe(report.after.total - 1);
    expect(count(db, "commands")).toBe(1);
    expect(count(db, "occurrence_events")).toBe(1);
    expect(count(db, "deliveries")).toBe(1);
    expect(count(db, "delivery_attempts")).toBe(1);
  });
});

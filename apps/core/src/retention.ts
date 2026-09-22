import type { StateHubDatabase } from "./database.js";

export const DEFAULT_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION_MAX_BYTES = 100 * 1024 * 1024;

export interface RetentionPolicy {
  maxAgeMs?: number;
  maxBytes?: number;
}

export interface HistoricalSize {
  history: number;
  events: number;
  deliveries: number;
  attempts: number;
  commands: number;
  total: number;
}

export interface RetentionReport {
  cutoff: string;
  before: HistoricalSize;
  after: HistoricalSize;
  removed: {
    history: number;
    events: number;
    deliveries: number;
    attempts: number;
    commands: number;
  };
  protectedBytesOverBudget: number;
}

type HistoricalTable = "history" | "events" | "deliveries" | "commands";

interface RetentionCandidate {
  table_name: HistoricalTable;
  row_key: string;
  secondary_key: string | null;
  retained_at: string;
  size_bytes: number;
}

interface CountRow {
  count: number;
}

interface BytesRow {
  bytes: number;
}

const CAPACITY_CLEANUP_BATCH_SIZE = 512;

const textBytes = (column: string): string =>
  `COALESCE(length(CAST(${column} AS BLOB)), 0)`;

const historyBytes = ["kind", "subject_id", "payload_json", "created_at"]
  .map(textBytes)
  .join(" + ");
const eventBytes = [
  "producer_id",
  "event_id",
  "type",
  "scope_id",
  "source_type",
  "value_json",
  "urgency",
  "occurred_at",
  "metadata_json",
  "accepted_at",
].map(textBytes).join(" + ") + " + 8";
const deliveryBytes = [
  "id",
  "command_id",
  "producer_id",
  "event_id",
  "driver_instance_id",
  "resource_channel",
  "action_kind",
  "action_json",
  "batch_key",
  "batch_id",
  "status",
  "available_at",
  "deadline_at",
  "lease_until",
  "last_error",
  "created_at",
  "completed_at",
].map(textBytes).join(" + ") + " + 24";
const attemptBytes = [
  "delivery_id",
  "started_at",
  "completed_at",
  "status",
  "detail",
].map(textBytes).join(" + ") + " + 16";
const commandBytes = [
  "id",
  "producer_id",
  "kind",
  "idempotency_key",
  "request_hash",
  "status",
  "accepted_at",
  "completed_at",
  "error_code",
  "error_message",
].map(textBytes).join(" + ");
const commandIdentityBytes = [
  "producer_id", "key_hash", "command_id", "kind", "request_hash", "status", "accepted_at", "completed_at",
]
  .map(textBytes).join(" + ");
const eventIdentityBytes = ["producer_id", "event_id_hash"].map(textBytes).join(" + ");

function validatePolicyValue(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function sum(raw: StateHubDatabase["raw"], query: string): number {
  return (raw.prepare(query).get() as BytesRow).bytes;
}

export function measureHistoricalSize(raw: StateHubDatabase["raw"]): HistoricalSize {
  const history = sum(raw, `SELECT COALESCE(sum(${historyBytes}), 0) AS bytes FROM history`);
  const events = sum(raw, `SELECT COALESCE(sum(${eventBytes}), 0) AS bytes FROM occurrence_events`)
    + sum(raw, `SELECT COALESCE(sum(${eventIdentityBytes}), 0) AS bytes FROM event_dedupe`);
  const deliveries = sum(raw, `SELECT COALESCE(sum(${deliveryBytes}), 0) AS bytes FROM deliveries`);
  const attempts = sum(raw, `SELECT COALESCE(sum(${attemptBytes}), 0) AS bytes FROM delivery_attempts`);
  const commands = sum(raw, `SELECT COALESCE(sum(${commandBytes}), 0) AS bytes FROM commands`)
    + sum(raw, `SELECT COALESCE(sum(${commandIdentityBytes}), 0) AS bytes FROM command_dedupe`);
  return {
    history,
    events,
    deliveries,
    attempts,
    commands,
    total: history + events + deliveries + attempts + commands,
  };
}

export class RetentionService {
  readonly maxAgeMs: number;
  readonly maxBytes: number;

  constructor(
    private readonly db: StateHubDatabase,
    policy: RetentionPolicy = {},
  ) {
    this.maxAgeMs = policy.maxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS;
    this.maxBytes = policy.maxBytes ?? DEFAULT_RETENTION_MAX_BYTES;
    validatePolicyValue("retention max age", this.maxAgeMs);
    validatePolicyValue("retention max bytes", this.maxBytes);
  }

  measure(): HistoricalSize {
    return measureHistoricalSize(this.db.raw);
  }

  run(now = new Date()): RetentionReport {
    const cutoff = new Date(now.getTime() - this.maxAgeMs).toISOString();
    return this.db.transaction(() => {
      const before = this.measure();
      const beforeCounts = this.countRows();

      this.removeExpired(cutoff);
      let size = this.measure();
      while (size.total > this.maxBytes) {
        const candidates = this.oldestCandidates(CAPACITY_CLEANUP_BATCH_SIZE);
        if (candidates.length === 0) break;
        let estimatedBytes = size.total;
        for (const candidate of candidates) {
          this.removeCandidate(candidate);
          estimatedBytes -= candidate.size_bytes;
          if (estimatedBytes <= this.maxBytes) break;
        }
        size = this.measure();
      }

      const after = size;
      const afterCounts = this.countRows();
      return {
        cutoff,
        before,
        after,
        removed: {
          history: beforeCounts.history - afterCounts.history,
          events: beforeCounts.events - afterCounts.events,
          deliveries: beforeCounts.deliveries - afterCounts.deliveries,
          attempts: beforeCounts.attempts - afterCounts.attempts,
          commands: beforeCounts.commands - afterCounts.commands,
        },
        protectedBytesOverBudget: Math.max(0, after.total - this.maxBytes),
      };
    });
  }

  private removeExpired(cutoff: string): void {
    // Children go first. Attempts follow terminal deliveries through ON DELETE CASCADE.
    this.db.raw.prepare(
      `DELETE FROM deliveries
       WHERE status NOT IN ('pending', 'leased')
         AND COALESCE(completed_at, created_at) < ?`,
    ).run(cutoff);
    this.db.raw.prepare(
      `DELETE FROM occurrence_events AS event
       WHERE event.accepted_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM deliveries AS delivery
           WHERE delivery.producer_id = event.producer_id
             AND delivery.event_id = event.event_id
         )`,
    ).run(cutoff);
    this.db.raw.prepare(
      `DELETE FROM commands AS command
       WHERE command.completed_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM deliveries AS delivery WHERE delivery.command_id = command.id
         )`,
    ).run(cutoff);
    this.db.raw.prepare("DELETE FROM history WHERE created_at < ?").run(cutoff);
  }

  private oldestCandidates(limit: number): RetentionCandidate[] {
    return this.db.raw.prepare(
      `SELECT table_name, row_key, secondary_key, retained_at, size_bytes
       FROM (
         SELECT 'history' AS table_name, CAST(id AS TEXT) AS row_key, NULL AS secondary_key,
                created_at AS retained_at,
                ${historyBytes} AS size_bytes
         FROM history
         UNION ALL
         SELECT 'deliveries', id, NULL, COALESCE(completed_at, created_at),
                ${deliveryBytes} + COALESCE((
                  SELECT sum(${attemptBytes.replaceAll(/\b(delivery_id|started_at|completed_at|status|detail)\b/gu, "attempt.$1")})
                  FROM delivery_attempts AS attempt WHERE attempt.delivery_id = deliveries.id
                ), 0)
         FROM deliveries
         WHERE status NOT IN ('pending', 'leased')
         UNION ALL
         SELECT 'events', producer_id, event_id, accepted_at, ${eventBytes}
         FROM occurrence_events AS event
         WHERE NOT EXISTS (
           SELECT 1 FROM deliveries AS delivery
           WHERE delivery.producer_id = event.producer_id
             AND delivery.event_id = event.event_id
         )
         UNION ALL
         SELECT 'commands', id, NULL, completed_at, ${commandBytes}
         FROM commands AS command
         WHERE completed_at IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM deliveries AS delivery WHERE delivery.command_id = command.id
           )
       )
       ORDER BY retained_at ASC, table_name ASC, row_key ASC, secondary_key ASC
       LIMIT ?`,
    ).all(limit) as RetentionCandidate[];
  }

  private removeCandidate(candidate: RetentionCandidate): void {
    switch (candidate.table_name) {
      case "history":
        this.db.raw.prepare("DELETE FROM history WHERE id = ?").run(candidate.row_key);
        break;
      case "deliveries":
        this.db.raw.prepare(
          "DELETE FROM deliveries WHERE id = ? AND status NOT IN ('pending', 'leased')",
        ).run(candidate.row_key);
        break;
      case "events": {
        if (candidate.secondary_key === null) throw new Error("Event retention candidate has no event id");
        this.db.raw.prepare(
          `DELETE FROM occurrence_events
           WHERE producer_id = ? AND event_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM deliveries
               WHERE producer_id = ? AND event_id = ?
             )`,
        ).run(candidate.row_key, candidate.secondary_key, candidate.row_key, candidate.secondary_key);
        break;
      }
      case "commands":
        this.db.raw.prepare(
          `DELETE FROM commands
           WHERE id = ? AND completed_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM deliveries WHERE command_id = ?)`,
        ).run(candidate.row_key, candidate.row_key);
        break;
    }
  }

  private countRows(): Omit<RetentionReport["removed"], "attempts"> & { attempts: number } {
    return {
      history: this.count("history"),
      events: this.count("occurrence_events"),
      deliveries: this.count("deliveries"),
      attempts: this.count("delivery_attempts"),
      commands: this.count("commands"),
    };
  }

  private count(table: string): number {
    return (this.db.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get() as CountRow).count;
  }
}

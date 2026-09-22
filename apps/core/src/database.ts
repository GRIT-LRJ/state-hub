import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { dedupeIdentityHash } from "./dedupe-identity.js";
import { resourceKey } from "@state-hub/domain";

const schema = String.raw`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('revision', '0');

CREATE TABLE IF NOT EXISTS producer_tokens (
  producer_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  source_definition_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS source_scopes (
  producer_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  source_type TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (producer_id, scope_id)
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT,
  status TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(producer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS commands_completed_at ON commands(completed_at);

CREATE TABLE IF NOT EXISTS command_dedupe (
  producer_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_hash TEXT,
  status TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (producer_id, key_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS command_dedupe_command ON command_dedupe(command_id);

CREATE TABLE IF NOT EXISTS claims (
  producer_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  source_type TEXT,
  value_json TEXT NOT NULL,
  urgency TEXT NOT NULL,
  expires_at TEXT,
  stale_policy TEXT NOT NULL,
  observed_at TEXT,
  metadata_json TEXT,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (producer_id, scope_id, signal_id)
);

CREATE TABLE IF NOT EXISTS claim_expirations (
  producer_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  claim_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (producer_id, scope_id, signal_id, claim_revision)
);

CREATE TABLE IF NOT EXISTS occurrence_events (
  producer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  scope_id TEXT,
  source_type TEXT,
  value_json TEXT,
  urgency TEXT NOT NULL,
  occurred_at TEXT,
  metadata_json TEXT,
  revision INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (producer_id, event_id)
);
CREATE INDEX IF NOT EXISTS occurrence_events_accepted_at ON occurrence_events(accepted_at);

CREATE TABLE IF NOT EXISTS event_dedupe (
  producer_id TEXT NOT NULL,
  event_id_hash TEXT NOT NULL,
  PRIMARY KEY (producer_id, event_id_hash)
);

CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  config_revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acknowledgements (
  claim_key TEXT NOT NULL,
  claim_revision INTEGER NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (claim_key, claim_revision)
);

CREATE TABLE IF NOT EXISTS binding_transitions (
  binding_id TEXT NOT NULL,
  input_key TEXT NOT NULL,
  value_signature TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (binding_id, input_key)
);

CREATE TABLE IF NOT EXISTS projections (
  resource_key TEXT PRIMARY KEY,
  driver_instance_id TEXT NOT NULL,
  resource_channel TEXT NOT NULL,
  action_json TEXT,
  urgency TEXT,
  contributors_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  command_id TEXT,
  producer_id TEXT,
  event_id TEXT,
  event_revision INTEGER,
  driver_instance_id TEXT NOT NULL,
  resource_channel TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_json TEXT,
  projection_revision INTEGER,
  batch_key TEXT,
  batch_id TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  deadline_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_ready ON deliveries(status, available_at, lease_until);
CREATE INDEX IF NOT EXISTS deliveries_completed_at ON deliveries(completed_at);
CREATE INDEX IF NOT EXISTS deliveries_command ON deliveries(command_id);
CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(producer_id, event_id);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS driver_instances (
  id TEXT PRIMARY KEY,
  driver_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  physical_resource_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS config_revisions (
  revision INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS plugin_publishers (
  id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  trusted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_packages (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  signed INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  source_definitions_json TEXT NOT NULL,
  driver_definitions_json TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  archive_blob BLOB NOT NULL,
  installed_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_packages_one_active ON plugin_packages(id) WHERE active = 1;


CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value_json) VALUES ('outputsPaused', 'false');

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_created_at ON history(created_at);

INSERT OR IGNORE INTO meta(key, value)
SELECT 'projection_revision', CAST(COALESCE(MAX(revision), 0) AS TEXT) FROM projections;
`;

export class StateHubDatabase {
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.exec(schema);
    const producerColumns = this.raw.pragma("table_info(producer_tokens)") as Array<{ name: string }>;
    if (!producerColumns.some((column) => column.name === "source_definition_id")) {
      this.raw.exec("ALTER TABLE producer_tokens ADD COLUMN source_definition_id TEXT");
    }
    const deliveryColumns = this.raw.pragma("table_info(deliveries)") as Array<{ name: string }>;
    if (!deliveryColumns.some((column) => column.name === "producer_id")) {
      this.raw.exec("ALTER TABLE deliveries ADD COLUMN producer_id TEXT");
    }
    if (!deliveryColumns.some((column) => column.name === "event_id")) {
      this.raw.exec("ALTER TABLE deliveries ADD COLUMN event_id TEXT");
    }
    if (!deliveryColumns.some((column) => column.name === "event_revision")) {
      this.raw.exec("ALTER TABLE deliveries ADD COLUMN event_revision INTEGER");
    }
    if (!deliveryColumns.some((column) => column.name === "batch_key")) {
      this.raw.exec("ALTER TABLE deliveries ADD COLUMN batch_key TEXT");
    }
    if (!deliveryColumns.some((column) => column.name === "batch_id")) {
      this.raw.exec("ALTER TABLE deliveries ADD COLUMN batch_id TEXT");
    }
    this.raw.exec(
      "CREATE INDEX IF NOT EXISTS deliveries_open_batch ON deliveries(batch_key, status, attempt_count, available_at)",
    );
    this.raw.transaction(() => {
      const projectionRows = this.raw.prepare(
        "SELECT resource_key, driver_instance_id, resource_channel FROM projections",
      ).all() as Array<{ resource_key: string; driver_instance_id: string; resource_channel: string }>;
      const updateProjectionKey = this.raw.prepare(
        "UPDATE projections SET resource_key = ? WHERE resource_key = ?",
      );
      for (const projection of projectionRows) {
        const canonicalKey = resourceKey(projection.driver_instance_id, projection.resource_channel);
        if (canonicalKey !== projection.resource_key) {
          updateProjectionKey.run(canonicalKey, projection.resource_key);
        }
      }
      const commandIdentity = this.raw.prepare(
        `INSERT OR IGNORE INTO command_dedupe(
           producer_id, key_hash, command_id, kind, request_hash, status, accepted_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const commands = this.raw.prepare(
        `SELECT producer_id, idempotency_key, id, kind, request_hash, status, accepted_at, completed_at
         FROM commands WHERE idempotency_key IS NOT NULL`,
      ).all() as Array<{
        producer_id: string;
        idempotency_key: string;
        id: string;
        kind: string;
        request_hash: string | null;
        status: string;
        accepted_at: string;
        completed_at: string | null;
      }>;
      for (const command of commands) {
        commandIdentity.run(
          command.producer_id,
          dedupeIdentityHash(command.idempotency_key),
          command.id,
          command.kind,
          command.request_hash,
          command.status,
          command.accepted_at,
          command.completed_at,
        );
      }
      const eventIdentity = this.raw.prepare(
        "INSERT OR IGNORE INTO event_dedupe(producer_id, event_id_hash) VALUES (?, ?)",
      );
      const events = this.raw.prepare("SELECT producer_id, event_id FROM occurrence_events")
        .all() as Array<{ producer_id: string; event_id: string }>;
      for (const event of events) {
        eventIdentity.run(event.producer_id, dedupeIdentityHash(event.event_id));
      }
    })();
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(work: () => T): T {
    return this.raw.transaction(work)();
  }

  nextRevision(): number {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: string };
    const revision = Number.parseInt(row.value, 10) + 1;
    this.raw.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(revision));
    return revision;
  }

  nextProjectionRevision(): number {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'projection_revision'").get() as { value: string };
    const revision = Number.parseInt(row.value, 10) + 1;
    this.raw.prepare("UPDATE meta SET value = ? WHERE key = 'projection_revision'").run(String(revision));
    return revision;
  }

  currentProjectionRevision(): number {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'projection_revision'").get() as { value: string };
    return Number.parseInt(row.value, 10);
  }

  currentRevision(): number {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: string };
    return Number.parseInt(row.value, 10);
  }
}

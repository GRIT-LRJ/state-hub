import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

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
  driver_instance_id TEXT NOT NULL,
  resource_channel TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_json TEXT,
  projection_revision INTEGER,
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

  currentRevision(): number {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: string };
    return Number.parseInt(row.value, 10);
  }
}

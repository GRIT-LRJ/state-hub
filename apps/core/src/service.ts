import { createHash, randomUUID } from "node:crypto";
import type {
  AcceptedCommand,
  ActionCandidate,
  ActionKind,
  Binding,
  CommandKind,
  CommandResult,
  OccurrenceEvent,
  OccurrenceEventInput,
  Projection,
  StateClaim,
  StateClaimInput,
} from "@state-hub/protocol";
import {
  actionSignature,
  arbitrate,
  bindingMatchesClaim,
  bindingMatchesEvent,
  buildAction,
  candidateFromClaim,
  claimKey,
  resourceKey,
  stableStringify,
} from "@state-hub/domain";
import type { StateHubDatabase } from "./database.js";
import type { HubEventBus } from "./events.js";
import { authenticateProducer } from "./auth.js";
import { validateClaimValue, validateEventValue } from "./schema-validation.js";
import { safeDeliveryErrorSummary } from "./delivery-diagnostics.js";
import { dedupeIdentityHash } from "./dedupe-identity.js";
import { PluginRepository } from "./plugin-repository.js";

interface ClaimRow {
  producer_id: string;
  scope_id: string;
  signal_id: string;
  source_type: string | null;
  value_json: string;
  urgency: StateClaim["urgency"];
  expires_at: string | null;
  stale_policy: StateClaim["stalePolicy"];
  observed_at: string | null;
  metadata_json: string | null;
  revision: number;
  updated_at: string;
}

interface ProjectionRow {
  resource_key: string;
  driver_instance_id: string;
  resource_channel: string;
  action_json: string | null;
  urgency: Projection["urgency"];
  contributors_json: string;
  revision: number;
  updated_at: string;
}

interface BindingRow {
  payload_json: string;
}

interface CommandRow {
  id: string;
  producer_id: string;
  kind: CommandKind;
  status: CommandResult["status"];
  accepted_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  request_hash: string | null;
}

export interface SnapshotClaim extends StateClaimInput {
  scopeId: string;
  signalId: string;
}

export interface RuntimeSnapshot {
  revision: number;
  outputsPaused: boolean;
  claims: StateClaim[];
  projections: Projection[];
  pendingDeliveries: number;
  deadLetters: number;
}

export interface PendingClaimExpiration {
  producerId: string;
  scopeId: string;
  signalId: string;
  claimRevision: number;
  expiresAt: string;
}

export interface PublishedConfig {
  bindings: Binding[];
  driverInstances: Array<{
    id: string;
    driverType: string;
    enabled: boolean;
    config: Record<string, unknown>;
    physicalResourceKey?: string;
  }>;
}

export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function diagnosticIdentity(value: string | null | undefined): string | null {
  return value == null ? null : `sha256:${dedupeIdentityHash(value)}`;
}

function diagnosticEnum(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "other";
}

function diagnosticTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function diagnosticNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const diagnosticHistoryKinds = [
  "claim.upsert", "claim.clear", "event.emit", "snapshot.replace", "outputs.paused",
  "outputs.resumed", "config.published", "delivery.suppressed",
] as const;

function safeHistoryPayload(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const payload = value as Record<string, unknown>;
  const safe: Record<string, number> = {};
  for (const key of ["revision", "claimCount", "suppressedDeliveries"]) {
    if (typeof payload[key] === "number" && Number.isSafeInteger(payload[key])) {
      safe[key] = payload[key];
    }
  }
  if (Array.isArray(payload.claims)) safe.claimCount = payload.claims.length;
  return safe;
}

function decodeClaim(row: ClaimRow): StateClaim {
  return {
    producerId: row.producer_id,
    scopeId: row.scope_id,
    signalId: row.signal_id,
    value: JSON.parse(row.value_json) as unknown,
    urgency: row.urgency ?? "ambient",
    stalePolicy: row.stale_policy ?? "deactivate",
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.source_type ? { sourceType: row.source_type } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.observed_at ? { observedAt: row.observed_at } : {}),
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
  };
}

function decodeProjection(row: ProjectionRow): Projection {
  const contributors = JSON.parse(row.contributors_json) as {
    bindingIds: string[];
    claimKeys: string[];
  };
  return {
    resourceKey: row.resource_key,
    driverInstanceId: row.driver_instance_id,
    resourceChannel: row.resource_channel,
    action: row.action_json ? (JSON.parse(row.action_json) as Projection["action"]) : null,
    urgency: row.urgency,
    contributorBindingIds: contributors.bindingIds,
    contributorClaimKeys: contributors.claimKeys,
    revision: row.revision,
  };
}

function plusMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

export class StateHubService {
  readonly maxScopesPerProducer = 100;

  constructor(
    readonly db: StateHubDatabase,
    readonly events: HubEventBus,
    private readonly plugins: PluginRepository = new PluginRepository(db),
  ) {}

  isPaused(): boolean {
    const row = this.db.raw.prepare("SELECT value_json FROM settings WHERE key = 'outputsPaused'").get() as {
      value_json: string;
    };
    return JSON.parse(row.value_json) as boolean;
  }

  listBindings(): Binding[] {
    return (this.db.raw.prepare("SELECT payload_json FROM bindings ORDER BY id").all() as BindingRow[]).map(
      (row) => JSON.parse(row.payload_json) as Binding,
    );
  }

  listClaims(): StateClaim[] {
    return (this.db.raw.prepare("SELECT * FROM claims ORDER BY producer_id, scope_id, signal_id").all() as ClaimRow[]).map(
      decodeClaim,
    );
  }

  listProjections(): Projection[] {
    return (this.db.raw.prepare("SELECT * FROM projections ORDER BY resource_key").all() as ProjectionRow[]).map(
      decodeProjection,
    );
  }

  listPendingClaimExpirations(): PendingClaimExpiration[] {
    const rows = this.db.raw
      .prepare(
        `SELECT c.producer_id, c.scope_id, c.signal_id, c.revision, c.expires_at
         FROM claims c
         LEFT JOIN claim_expirations e
           ON e.producer_id = c.producer_id
          AND e.scope_id = c.scope_id
          AND e.signal_id = c.signal_id
          AND e.claim_revision = c.revision
         WHERE c.expires_at IS NOT NULL AND e.claim_revision IS NULL`,
      )
      .all() as Array<{
        producer_id: string;
        scope_id: string;
        signal_id: string;
        revision: number;
        expires_at: string;
      }>;
    return rows.map((row) => ({
      producerId: row.producer_id,
      scopeId: row.scope_id,
      signalId: row.signal_id,
      claimRevision: row.revision,
      expiresAt: row.expires_at,
    }));
  }

  processDueClaimExpirations(now = new Date()): number {
    const due = this.listPendingClaimExpirations().filter(
      (expiration) => Date.parse(expiration.expiresAt) <= now.getTime(),
    );
    if (due.length === 0) return 0;
    const nowIso = now.toISOString();
    let revision = 0;
    this.db.transaction(() => {
      revision = this.db.nextRevision();
      for (const expiration of due) {
        this.db.raw
          .prepare(
            `INSERT OR IGNORE INTO claim_expirations(
               producer_id, scope_id, signal_id, claim_revision, expires_at, applied_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            expiration.producerId,
            expiration.scopeId,
            expiration.signalId,
            expiration.claimRevision,
            expiration.expiresAt,
            nowIso,
          );
      }
      this.recomputeStateful(undefined, nowIso);
      this.appendHistory(
        "claims.expired",
        null,
        {
          revision,
          claims: due.map((expiration) =>
            claimKey(expiration.producerId, expiration.scopeId, expiration.signalId),
          ),
        },
        nowIso,
      );
    });
    this.events.publish("claims.expired", { revision, claims: due });
    this.events.publish("snapshot.changed", this.snapshot());
    return due.length;
  }

  snapshot(): RuntimeSnapshot {
    const pending = this.db.raw
      .prepare("SELECT count(*) AS count FROM deliveries WHERE status IN ('pending', 'leased')")
      .get() as { count: number };
    const dead = this.db.raw.prepare("SELECT count(*) AS count FROM deliveries WHERE status = 'dead-letter'").get() as {
      count: number;
    };
    return {
      revision: this.db.currentRevision(),
      outputsPaused: this.isPaused(),
      claims: this.listClaims(),
      projections: this.listProjections(),
      pendingDeliveries: pending.count,
      deadLetters: dead.count,
    };
  }

  getCommand(producerId: string, commandId: string): CommandResult | undefined {
    const row = this.db.raw
      .prepare("SELECT * FROM commands WHERE id = ? AND producer_id = ?")
      .get(commandId, producerId) as CommandRow | undefined;
    if (!row) {
      const identity = this.db.raw.prepare(
        `SELECT command_id, kind, status, accepted_at, completed_at FROM command_dedupe
         WHERE command_id = ? AND producer_id = ?`,
      ).get(commandId, producerId) as {
        command_id: string;
        kind: CommandKind;
        status: CommandResult["status"];
        accepted_at: string;
        completed_at: string | null;
      } | undefined;
      if (!identity) return undefined;
      return {
        commandId: identity.command_id,
        producerId,
        kind: identity.kind,
        status: identity.status,
        acceptedAt: identity.accepted_at,
        ...(identity.completed_at ? { completedAt: identity.completed_at } : {}),
      };
    }
    return {
      commandId: row.id,
      producerId: row.producer_id,
      kind: row.kind,
      status: row.status,
      acceptedAt: row.accepted_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    };
  }

  upsertClaim(
    producerId: string,
    producerToken: string | undefined,
    scopeId: string,
    signalId: string,
    input: StateClaimInput,
    idempotencyKey?: string,
  ): AcceptedCommand {
    return this.executeCommand(
      producerId,
      producerToken,
      "claim.upsert",
      idempotencyKey,
      { scopeId, signalId, input },
      () => {
        const validationError = validateClaimValue(this.db, producerId, signalId, input.value, this.plugins);
        if (validationError) throw new HubError("SOURCE_SCHEMA_VIOLATION", validationError, 422);
      },
      (commandId, revision, now) => {
        this.touchScope(producerId, scopeId, input.sourceType, now);
        this.db.raw
          .prepare("DELETE FROM claim_expirations WHERE producer_id = ? AND scope_id = ? AND signal_id = ?")
          .run(producerId, scopeId, signalId);
        this.db.raw
          .prepare(
            `INSERT INTO claims(
               producer_id, scope_id, signal_id, source_type, value_json, urgency, expires_at,
               stale_policy, observed_at, metadata_json, revision, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(producer_id, scope_id, signal_id) DO UPDATE SET
               source_type = excluded.source_type, value_json = excluded.value_json,
               urgency = excluded.urgency, expires_at = excluded.expires_at,
               stale_policy = excluded.stale_policy, observed_at = excluded.observed_at,
               metadata_json = excluded.metadata_json, revision = excluded.revision,
               updated_at = excluded.updated_at`,
          )
          .run(
            producerId,
            scopeId,
            signalId,
            input.sourceType ?? null,
            JSON.stringify(input.value),
            input.urgency ?? "ambient",
            input.expiresAt ?? null,
            input.stalePolicy ?? "deactivate",
            input.observedAt ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
            revision,
            now,
          );
        const claim = decodeClaim(
          this.db.raw
            .prepare("SELECT * FROM claims WHERE producer_id = ? AND scope_id = ? AND signal_id = ?")
            .get(producerId, scopeId, signalId) as ClaimRow,
        );
        this.enqueueClaimEffects(commandId, claim, now);
        this.recomputeStateful(commandId, now);
        this.appendHistory("claim.upsert", claimKey(producerId, scopeId, signalId), { revision }, now);
      },
    );
  }

  clearClaim(
    producerId: string,
    producerToken: string | undefined,
    scopeId: string,
    signalId: string,
    idempotencyKey?: string,
  ): AcceptedCommand {
    return this.executeCommand(
      producerId,
      producerToken,
      "claim.clear",
      idempotencyKey,
      { scopeId, signalId },
      undefined,
      (commandId, revision, now) => {
        const key = claimKey(producerId, scopeId, signalId);
        this.db.raw
          .prepare("DELETE FROM claims WHERE producer_id = ? AND scope_id = ? AND signal_id = ?")
          .run(producerId, scopeId, signalId);
        this.db.raw
          .prepare("DELETE FROM claim_expirations WHERE producer_id = ? AND scope_id = ? AND signal_id = ?")
          .run(producerId, scopeId, signalId);
        this.db.raw.prepare("DELETE FROM binding_transitions WHERE input_key = ?").run(key);
        this.recomputeStateful(commandId, now);
        this.appendHistory("claim.clear", key, { revision }, now);
      },
    );
  }

  emitEvent(
    producerId: string,
    producerToken: string | undefined,
    input: OccurrenceEventInput,
    idempotencyKey?: string,
  ): AcceptedCommand {
    return this.executeCommand(
      producerId,
      producerToken,
      "event.emit",
      idempotencyKey ?? input.eventId,
      input,
      () => {
        const validationError = validateEventValue(this.db, producerId, input.type, input.value, this.plugins);
        if (validationError) throw new HubError("SOURCE_SCHEMA_VIOLATION", validationError, 422);
      },
      (commandId, revision, now) => {
        const eventIdHash = dedupeIdentityHash(input.eventId);
        const duplicate = this.db.raw
          .prepare("SELECT 1 FROM event_dedupe WHERE producer_id = ? AND event_id_hash = ?")
          .get(producerId, eventIdHash);
        if (duplicate) return;
        this.db.raw.prepare("INSERT INTO event_dedupe(producer_id, event_id_hash) VALUES (?, ?)")
          .run(producerId, eventIdHash);
        const scopeId = input.scopeId ?? "default";
        this.touchScope(producerId, scopeId, input.sourceType, now);
        this.db.raw
          .prepare(
            `INSERT INTO occurrence_events(
               producer_id, event_id, type, scope_id, source_type, value_json, urgency,
               occurred_at, metadata_json, revision, accepted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            producerId,
            input.eventId,
            input.type,
            scopeId,
            input.sourceType ?? null,
            input.value === undefined ? null : JSON.stringify(input.value),
            input.urgency ?? "ambient",
            input.occurredAt ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
            revision,
            now,
          );
        const event: OccurrenceEvent = {
          ...input,
          producerId,
          scopeId,
          revision,
          acceptedAt: now,
        };
        this.enqueueOccurrence(commandId, event, now);
        this.appendHistory("event.emit", input.eventId, { type: input.type, revision }, now);
      },
    );
  }

  replaceSnapshot(
    producerId: string,
    producerToken: string | undefined,
    claims: SnapshotClaim[],
    idempotencyKey?: string,
  ): AcceptedCommand {
    return this.executeCommand(
      producerId,
      producerToken,
      "snapshot.replace",
      idempotencyKey,
      claims,
      () => {
        const identities = new Set<string>();
        for (const claim of claims) {
          const identity = JSON.stringify([claim.scopeId, claim.signalId]);
          if (identities.has(identity)) throw new HubError("DUPLICATE_SNAPSHOT_CLAIM", "Snapshot contains a duplicate claim identity");
          identities.add(identity);
          const validationError = validateClaimValue(this.db, producerId, claim.signalId, claim.value, this.plugins);
          if (validationError) throw new HubError("SOURCE_SCHEMA_VIOLATION", validationError, 422);
        }
      },
      (commandId, revision, now) => {
        const priorClaims = this.db.raw
          .prepare("SELECT scope_id, signal_id FROM claims WHERE producer_id = ?")
          .all(producerId) as Array<{ scope_id: string; signal_id: string }>;
        const deleteTransition = this.db.raw.prepare(
          "DELETE FROM binding_transitions WHERE input_key = ?",
        );
        for (const priorClaim of priorClaims) {
          deleteTransition.run(claimKey(producerId, priorClaim.scope_id, priorClaim.signal_id));
        }
        this.db.raw.prepare("DELETE FROM claims WHERE producer_id = ?").run(producerId);
        this.db.raw.prepare("DELETE FROM claim_expirations WHERE producer_id = ?").run(producerId);
        for (const input of claims) {
          this.touchScope(producerId, input.scopeId, input.sourceType, now);
          this.db.raw
            .prepare(
              `INSERT INTO claims(
                 producer_id, scope_id, signal_id, source_type, value_json, urgency, expires_at,
                 stale_policy, observed_at, metadata_json, revision, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              producerId,
              input.scopeId,
              input.signalId,
              input.sourceType ?? null,
              JSON.stringify(input.value),
              input.urgency ?? "ambient",
              input.expiresAt ?? null,
              input.stalePolicy ?? "deactivate",
              input.observedAt ?? null,
              input.metadata ? JSON.stringify(input.metadata) : null,
              revision,
              now,
            );
        }
        this.recomputeStateful(commandId, now);
        this.appendHistory("snapshot.replace", producerId, { claimCount: claims.length, revision }, now);
      },
    );
  }

  acknowledge(producerId: string, scopeId: string, signalId: string, claimRevision: number): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const current = this.db.raw
        .prepare("SELECT revision FROM claims WHERE producer_id = ? AND scope_id = ? AND signal_id = ?")
        .get(producerId, scopeId, signalId) as { revision: number } | undefined;
      if (!current || current.revision !== claimRevision) {
        throw new HubError("CLAIM_REVISION_MISMATCH", "The claim no longer has the requested revision", 409);
      }
      this.db.raw
        .prepare("INSERT OR IGNORE INTO acknowledgements(claim_key, claim_revision, acknowledged_at) VALUES (?, ?, ?)")
        .run(claimKey(producerId, scopeId, signalId), claimRevision, now);
      const revision = this.db.nextRevision();
      this.recomputeStateful(undefined, now);
    });
    this.events.publish("snapshot.changed", this.snapshot());
  }

  setPaused(paused: boolean): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.raw
        .prepare("UPDATE settings SET value_json = ? WHERE key = 'outputsPaused'")
        .run(JSON.stringify(paused));
      const suppressedDeliveries = paused
        ? this.db.raw
            .prepare(
              `UPDATE deliveries
               SET status = 'suppressed', completed_at = ?, lease_until = NULL,
                   last_error = 'Outputs paused before delivery'
               WHERE action_kind IN ('queued-effect', 'append-only')
                 AND status IN ('pending', 'leased')`,
            )
            .run(now).changes
        : 0;
      const revision = this.db.nextRevision();
      this.recomputeStateful(undefined, now);
      this.appendHistory(paused ? "outputs.paused" : "outputs.resumed", null, { suppressedDeliveries }, now);
    });
    this.events.publish("outputs.pause-changed", { paused });
    this.events.publish("snapshot.changed", this.snapshot());
  }

  createConfigDraft(config: PublishedConfig): { revision: number; impact: Record<string, unknown> } {
    this.validateConfig(config);
    return this.db.transaction(() => {
      const revision = this.db.nextRevision();
      const currentBindingIds = new Set(this.listBindings().map((binding) => binding.id));
      const nextBindingIds = new Set(config.bindings.map((binding) => binding.id));
      const impact = {
        bindingsAdded: [...nextBindingIds].filter((id) => !currentBindingIds.has(id)),
        bindingsRemoved: [...currentBindingIds].filter((id) => !nextBindingIds.has(id)),
        currentClaimsReevaluated: this.listClaims().length,
        historicalEventsReplayed: 0,
      };
      this.db.raw
        .prepare(
          "INSERT INTO config_revisions(revision, status, config_json, impact_json, created_at) VALUES (?, 'draft', ?, ?, ?)",
        )
        .run(revision, JSON.stringify(config), JSON.stringify(impact), new Date().toISOString());
      return { revision, impact };
    });
  }

  publishConfig(revision: number): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const draft = this.db.raw
        .prepare("SELECT status, config_json FROM config_revisions WHERE revision = ?")
        .get(revision) as { status: string; config_json: string } | undefined;
      if (!draft || draft.status !== "draft") throw new HubError("CONFIG_DRAFT_NOT_FOUND", "Draft not found", 404);
      const config = JSON.parse(draft.config_json) as PublishedConfig;
      this.validateConfig(config);
      const replacements = new Map(config.driverInstances.map((instance) => [instance.id, instance]));
      const currentInstances = this.db.raw.prepare(
        "SELECT id, driver_type, enabled FROM driver_instances",
      ).all() as Array<{ id: string; driver_type: string; enabled: number }>;
      for (const current of currentInstances) {
        const replacement = replacements.get(current.id);
        const changed = !replacement || current.driver_type !== replacement.driverType ||
          current.enabled !== (replacement.enabled ? 1 : 0);
        if (!changed) continue;
        const unfinished = this.db.raw.prepare(
          `SELECT 1 FROM deliveries WHERE driver_instance_id = ? AND action_kind = 'append-only'
             AND status IN ('pending', 'leased') LIMIT 1`,
        ).get(current.id);
        if (unfinished) {
          throw new HubError("CONFIG_PENDING_DELIVERIES",
            "Settle append-only deliveries before changing their driver instance", 409);
        }
      }
      this.db.raw.prepare("DELETE FROM bindings").run();
      this.db.raw.prepare("DELETE FROM driver_instances").run();
      for (const instance of config.driverInstances) {
        this.db.raw
          .prepare(
            "INSERT INTO driver_instances(id, driver_type, config_json, enabled, physical_resource_key) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            instance.id,
            instance.driverType,
            JSON.stringify(instance.config),
            instance.enabled ? 1 : 0,
            instance.physicalResourceKey ?? null,
          );
      }
      for (const binding of config.bindings) {
        this.db.raw
          .prepare("INSERT INTO bindings(id, payload_json, config_revision) VALUES (?, ?, ?)")
          .run(binding.id, JSON.stringify(binding), revision);
      }
      this.db.raw.prepare("UPDATE config_revisions SET status = 'superseded' WHERE status = 'published'").run();
      this.db.raw
        .prepare("UPDATE config_revisions SET status = 'published', published_at = ? WHERE revision = ?")
        .run(now, revision);
      this.recomputeStateful(undefined, now);
      this.appendHistory("config.published", String(revision), {}, now);
    });
    this.events.publish("config.published", { revision });
    this.events.publish("snapshot.changed", this.snapshot());
  }

  createRollbackDraft(sourceRevision: number): { revision: number; impact: Record<string, unknown> } {
    const row = this.db.raw
      .prepare("SELECT config_json FROM config_revisions WHERE revision = ?")
      .get(sourceRevision) as { config_json: string } | undefined;
    if (!row) throw new HubError("CONFIG_REVISION_NOT_FOUND", "Configuration revision not found", 404);
    return this.createConfigDraft(JSON.parse(row.config_json) as PublishedConfig);
  }

  exportConfig(): PublishedConfig {
    const row = this.db.raw
      .prepare("SELECT config_json FROM config_revisions WHERE status = 'published' ORDER BY revision DESC LIMIT 1")
      .get() as { config_json: string } | undefined;
    if (row) return JSON.parse(row.config_json) as PublishedConfig;
    const driverInstances = this.db.raw
      .prepare("SELECT id, driver_type, config_json, enabled, physical_resource_key FROM driver_instances ORDER BY id")
      .all() as Array<{
      id: string;
      driver_type: string;
      config_json: string;
      enabled: number;
      physical_resource_key: string | null;
    }>;
    return {
      bindings: this.listBindings(),
      driverInstances: driverInstances.map((instance) => ({
        id: instance.id,
        driverType: instance.driver_type,
        enabled: instance.enabled === 1,
        config: JSON.parse(instance.config_json) as Record<string, unknown>,
        ...(instance.physical_resource_key ? { physicalResourceKey: instance.physical_resource_key } : {}),
      })),
    };
  }

  diagnosticPreview(): { files: Array<{ name: string; containsSecrets: false }>; redaction: string[] } {
    return {
      files: [{ name: "state-hub-support-bundle.json", containsSecrets: false }],
      redaction: ["claim and action values", "producer-controlled identifiers and config values", "driver error details", "producer token hashes"],
    };
  }

  diagnosticBundle(): Record<string, unknown> {
    const snapshot = this.snapshot();
    const config = this.exportConfig();
    const recentHistory = this.db.raw
      .prepare("SELECT kind, subject_id, payload_json, created_at FROM history ORDER BY id DESC LIMIT 500")
      .all() as Array<{ kind: string; subject_id: string | null; payload_json: string; created_at: string }>;
    const deliveries = this.db.raw
      .prepare(
        `SELECT id, command_id, producer_id, event_id, event_revision, batch_id, driver_instance_id, resource_channel,
                action_kind, status, attempt_count, deadline_at, last_error, created_at, completed_at
         FROM deliveries ORDER BY created_at DESC, id DESC LIMIT 500`,
      )
      .all() as Array<Record<string, unknown>>;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        revision: snapshot.revision,
        outputsPaused: snapshot.outputsPaused,
        claimCount: snapshot.claims.length,
        projections: snapshot.projections.map((projection) => ({
          resourceKey: diagnosticIdentity(projection.resourceKey),
          driverInstanceId: diagnosticIdentity(projection.driverInstanceId),
          resourceChannel: diagnosticIdentity(projection.resourceChannel),
          revision: projection.revision,
          urgency: projection.urgency === null ? null : diagnosticEnum(
            projection.urgency, ["critical", "action-required", "informational", "ambient"],
          ),
          hasAction: projection.action !== null,
          contributorBindingCount: projection.contributorBindingIds.length,
          contributorClaimCount: projection.contributorClaimKeys.length,
        })),
        pendingDeliveries: snapshot.pendingDeliveries,
        deadLetters: snapshot.deadLetters,
      },
      config: {
        bindings: config.bindings.map((binding) => ({
          id: diagnosticIdentity(binding.id),
          enabled: binding.enabled === true,
          driverInstanceId: diagnosticIdentity(binding.target.driverInstanceId),
          resourceChannel: diagnosticIdentity(binding.target.resourceChannel),
          actionKind: diagnosticEnum(binding.target.actionKind, ["stateful", "queued-effect", "append-only"]),
          conditionCount: binding.conditions.length,
          mappingFieldCount: Object.keys(binding.mapping).length,
          batchWindowMs: diagnosticNonNegativeInteger(binding.batchWindowMs),
        })),
        driverInstances: config.driverInstances.map((instance) => ({
          id: diagnosticIdentity(instance.id),
          driverType: diagnosticEnum(instance.driverType, ["virtual", "http", "pushplus", "vk87"]),
          enabled: instance.enabled === true,
        })),
      },
      history: recentHistory.map((row) => ({
        kind: diagnosticEnum(row.kind, diagnosticHistoryKinds),
        subjectId: diagnosticIdentity(row.subject_id),
        payload: safeHistoryPayload(JSON.parse(row.payload_json) as unknown),
        createdAt: diagnosticTimestamp(row.created_at),
      })),
      deliveries: deliveries.map((delivery) => ({
        deliveryId: diagnosticIdentity(delivery.id as string),
        commandId: diagnosticIdentity(delivery.command_id as string | null),
        producerId: diagnosticIdentity(delivery.producer_id as string | null),
        eventId: diagnosticIdentity(delivery.event_id as string | null),
        eventRevision: delivery.event_revision,
        batchId: diagnosticIdentity(delivery.batch_id as string | null),
        driverInstanceId: diagnosticIdentity(delivery.driver_instance_id as string),
        resourceChannel: diagnosticIdentity(delivery.resource_channel as string),
        actionKind: diagnosticEnum(delivery.action_kind, ["stateful", "queued-effect", "append-only"]),
        status: diagnosticEnum(delivery.status, ["pending", "leased", "delivered", "dead-letter", "suppressed"]),
        attemptCount: diagnosticNonNegativeInteger(delivery.attempt_count),
        deadlineAt: diagnosticTimestamp(delivery.deadline_at),
        lastError: safeDeliveryErrorSummary(delivery.last_error) ?? null,
        createdAt: diagnosticTimestamp(delivery.created_at),
        completedAt: diagnosticTimestamp(delivery.completed_at),
      })),
      claims: snapshot.claims.map((claim) => ({
        producerId: diagnosticIdentity(claim.producerId),
        scopeId: diagnosticIdentity(claim.scopeId),
        signalId: diagnosticIdentity(claim.signalId),
        revision: claim.revision,
        urgency: diagnosticEnum(claim.urgency, ["critical", "action-required", "informational", "ambient"]),
        value: "[REDACTED]",
      })),
    };
  }

  private executeCommand(
    producerId: string,
    producerToken: string | undefined,
    kind: CommandKind,
    idempotencyKey: string | undefined,
    request: unknown,
    validate: (() => void) | undefined,
    work: (commandId: string, revision: number, now: string) => void,
  ): AcceptedCommand {
    const requestHash = createHash("sha256").update(stableStringify({ kind, request })).digest("hex");
    const accepted = this.db.transaction(() => {
      if (!producerToken || !authenticateProducer(this.db, producerId, producerToken)) {
        throw new HubError("UNAUTHORIZED_PRODUCER", "Invalid producer token", 401);
      }
      validate?.();
      if (idempotencyKey) {
        const existing = this.db.raw
          .prepare("SELECT command_id, request_hash, accepted_at FROM command_dedupe WHERE producer_id = ? AND key_hash = ?")
          .get(producerId, dedupeIdentityHash(idempotencyKey)) as {
            command_id: string;
            request_hash: string | null;
            accepted_at: string;
          } | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new HubError("IDEMPOTENCY_CONFLICT", "The idempotency key was used for a different request", 409);
          }
          return { commandId: existing.command_id, status: "accepted" as const, acceptedAt: existing.accepted_at };
        }
      }
      const commandId = randomUUID();
      const now = new Date().toISOString();
      this.db.raw
        .prepare(
          `INSERT INTO commands(id, producer_id, kind, idempotency_key, request_hash, status, accepted_at)
           VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(commandId, producerId, kind, idempotencyKey ?? null, requestHash, now);
      if (idempotencyKey) {
        this.db.raw.prepare(
          `INSERT INTO command_dedupe(
             producer_id, key_hash, command_id, kind, request_hash, status, accepted_at
           ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
        ).run(producerId, dedupeIdentityHash(idempotencyKey), commandId, kind, requestHash, now);
      }
      const revision = this.db.nextRevision();
      work(commandId, revision, now);
      this.db.raw
        .prepare("UPDATE commands SET status = 'applied', completed_at = ? WHERE id = ?")
        .run(now, commandId);
      if (idempotencyKey) {
        this.db.raw.prepare(
          "UPDATE command_dedupe SET status = 'applied', completed_at = ? WHERE producer_id = ? AND key_hash = ?",
        ).run(now, producerId, dedupeIdentityHash(idempotencyKey));
      }
      return { commandId, status: "accepted" as const, acceptedAt: now };
    });
    this.events.publish("command.accepted", { producerId, kind, ...accepted });
    this.events.publish("snapshot.changed", this.snapshot());
    return accepted;
  }

  private touchScope(producerId: string, scopeId: string, sourceType: string | undefined, now: string): void {
    const exists = this.db.raw
      .prepare("SELECT 1 FROM source_scopes WHERE producer_id = ? AND scope_id = ?")
      .get(producerId, scopeId);
    if (!exists) {
      const count = this.db.raw
        .prepare("SELECT count(*) AS count FROM source_scopes WHERE producer_id = ?")
        .get(producerId) as { count: number };
      if (count.count >= this.maxScopesPerProducer) {
        throw new HubError("SCOPE_QUOTA_EXCEEDED", `Producer scope quota ${this.maxScopesPerProducer} exceeded`, 429);
      }
    }
    this.db.raw
      .prepare(
        `INSERT INTO source_scopes(producer_id, scope_id, source_type, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(producer_id, scope_id) DO UPDATE SET
           source_type = COALESCE(excluded.source_type, source_scopes.source_type),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(producerId, scopeId, sourceType ?? null, now, now);
  }

  private recomputeStateful(commandId: string | undefined, now: string): void {
    const bindings = this.listBindings().filter((binding) => binding.target.actionKind === "stateful");
    const claims = this.listClaims();
    const candidates: ActionCandidate[] = [];
    for (const claim of claims) {
      for (const binding of bindings) {
        const key = claimKey(claim.producerId, claim.scopeId, claim.signalId);
        const acknowledged = Boolean(
          this.db.raw
            .prepare("SELECT 1 FROM acknowledgements WHERE claim_key = ? AND claim_revision = ?")
            .get(key, claim.revision),
        );
        const candidate = candidateFromClaim(binding, claim, claim.revision, acknowledged, new Date(now));
        if (candidate) candidates.push(candidate);
      }
    }
    let next = arbitrate(candidates, 0);
    const paused = this.isPaused();
    if (paused) next = next.map((projection) => ({ ...projection, action: null, urgency: null }));
    const byKey = new Map(next.map((projection) => [projection.resourceKey, projection]));
    const old = this.listProjections();
    for (const previous of old) {
      if (!byKey.has(previous.resourceKey)) {
        byKey.set(previous.resourceKey, {
          ...previous,
          action: null,
          urgency: null,
          contributorBindingIds: [],
          contributorClaimKeys: [],
          revision: previous.revision,
        });
      }
    }
    for (const projection of byKey.values()) {
      const previous = old.find((item) => item.resourceKey === projection.resourceKey);
      const changed = !previous || actionSignature(previous.action) !== actionSignature(projection.action);
      const projectionRevision = changed ? this.db.nextProjectionRevision() : previous.revision;
      this.db.raw
        .prepare(
          `INSERT INTO projections(
             resource_key, driver_instance_id, resource_channel, action_json, urgency,
             contributors_json, revision, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(resource_key) DO UPDATE SET
             action_json = excluded.action_json, urgency = excluded.urgency,
             contributors_json = excluded.contributors_json, revision = excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .run(
          projection.resourceKey,
          projection.driverInstanceId,
          projection.resourceChannel,
          projection.action ? JSON.stringify(projection.action) : null,
          projection.urgency,
          JSON.stringify({
            bindingIds: projection.contributorBindingIds,
            claimKeys: projection.contributorClaimKeys,
          }),
          projectionRevision,
          now,
        );
      if (changed) {
        this.enqueueDelivery(
          commandId,
          projection.driverInstanceId,
          projection.resourceChannel,
          "stateful",
          projection.action,
          now,
          projectionRevision,
        );
      }
    }
  }

  private enqueueClaimEffects(commandId: string, claim: StateClaim, now: string): void {
    for (const binding of this.listBindings()) {
      if (binding.target.actionKind === "stateful" || !bindingMatchesClaim(binding, claim)) continue;
      const inputKey = claimKey(claim.producerId, claim.scopeId, claim.signalId);
      const signature = stableStringify(claim.value);
      const previous = this.db.raw
        .prepare("SELECT value_signature FROM binding_transitions WHERE binding_id = ? AND input_key = ?")
        .get(binding.id, inputKey) as { value_signature: string } | undefined;
      const transitionOnly = binding.transitionOnly ?? true;
      this.db.raw
        .prepare(
          `INSERT INTO binding_transitions(binding_id, input_key, value_signature, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(binding_id, input_key) DO UPDATE SET
             value_signature = excluded.value_signature, updated_at = excluded.updated_at`,
        )
        .run(binding.id, inputKey, signature, now);
      if (transitionOnly && previous?.value_signature === signature) continue;
      if (this.isPaused()) {
        this.appendHistory("delivery.suppressed", binding.id, { reason: "outputs-paused" }, now);
        continue;
      }
      this.enqueueDelivery(
        commandId,
        binding.target.driverInstanceId,
        binding.target.resourceChannel,
        binding.target.actionKind,
        buildAction(binding, claim.value),
        now,
      );
    }
  }

  private enqueueOccurrence(commandId: string, event: OccurrenceEvent, now: string): void {
    for (const binding of this.listBindings()) {
      if (!bindingMatchesEvent(binding, event) || binding.target.actionKind === "stateful") continue;
      if (this.isPaused()) {
        this.appendHistory("delivery.suppressed", binding.id, { reason: "outputs-paused" }, now);
        continue;
      }
      const action = buildAction(binding, event.value);
      const batchWindowMs = binding.target.actionKind === "append-only" ? binding.batchWindowMs ?? 0 : 0;
      const deliveryDelayMs = binding.target.actionKind === "append-only" ? 0 : binding.batchWindowMs ?? 0;
      this.enqueueDelivery(
        commandId,
        binding.target.driverInstanceId,
        binding.target.resourceChannel,
        binding.target.actionKind,
        action,
        now,
        undefined,
        {
          eventId: event.eventId,
          producerId: event.producerId,
          eventRevision: event.revision,
          ...(deliveryDelayMs > 0 ? { delayMs: deliveryDelayMs } : {}),
          ...(batchWindowMs > 0
            ? {
                batchKey: JSON.stringify([binding.id, action.name]),
                batchWindowMs,
              }
            : {}),
        },
      );
    }
  }

  private enqueueDelivery(
    commandId: string | undefined,
    driverInstanceId: string,
    channel: string,
    kind: ActionKind,
    action: Projection["action"],
    createdAt: string,
    projectionRevision?: number,
    options: {
      producerId?: string;
      eventId?: string;
      eventRevision?: number;
      batchKey?: string;
      batchWindowMs?: number;
      delayMs?: number;
    } = {},
  ): void {
    let batchId: string | undefined;
    let availableAt = plusMilliseconds(createdAt, options.delayMs ?? 0);
    if (kind === "append-only" && options.batchKey && options.batchWindowMs && options.batchWindowMs > 0) {
      const openBatch = this.db.raw
        .prepare(
          `SELECT batch_id, available_at FROM deliveries
           WHERE batch_key = ? AND driver_instance_id = ? AND resource_channel = ?
             AND action_kind = 'append-only' AND status = 'pending' AND attempt_count = 0
             AND available_at > ?
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(options.batchKey, driverInstanceId, channel, createdAt) as
        | { batch_id: string; available_at: string }
        | undefined;
      batchId = openBatch?.batch_id ?? randomUUID();
      availableAt = openBatch?.available_at ?? plusMilliseconds(createdAt, options.batchWindowMs);
    }
    const deadlineAt =
      kind === "append-only"
        ? plusMilliseconds(createdAt, 24 * 60 * 60 * 1000)
        : kind === "queued-effect"
          ? plusMilliseconds(createdAt, 30_000)
          : null;
    this.db.raw
      .prepare(
        `INSERT INTO deliveries(
           id, command_id, producer_id, event_id, event_revision,
           driver_instance_id, resource_channel, action_kind, action_json,
           projection_revision, batch_key, batch_id, status, available_at, deadline_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        commandId ?? null,
        options.producerId ?? null,
        options.eventId ?? null,
        options.eventRevision ?? null,
        driverInstanceId,
        channel,
        kind,
        action ? JSON.stringify(action) : null,
        projectionRevision ?? null,
        options.batchKey ?? null,
        batchId ?? null,
        availableAt,
        deadlineAt,
        createdAt,
      );
  }

  private validateConfig(config: PublishedConfig): void {
    const instanceIds = new Set<string>();
    const physicalKeys = new Set<string>();
    for (const instance of config.driverInstances) {
      if (instanceIds.has(instance.id)) throw new HubError("DUPLICATE_DRIVER_INSTANCE", instance.id);
      instanceIds.add(instance.id);
      if (!["virtual", "http", "pushplus", "vk87"].includes(instance.driverType) &&
        !this.plugins.hasInstalledDriverType(instance.driverType)) {
        throw new HubError("UNKNOWN_DRIVER_TYPE", "Driver type is not installed");
      }
      if (instance.physicalResourceKey) {
        if (physicalKeys.has(instance.physicalResourceKey)) {
          throw new HubError("PHYSICAL_RESOURCE_CONFLICT", instance.physicalResourceKey, 409);
        }
        physicalKeys.add(instance.physicalResourceKey);
      }
    }
    const bindingIds = new Set<string>();
    for (const binding of config.bindings) {
      if (bindingIds.has(binding.id)) throw new HubError("DUPLICATE_BINDING", binding.id);
      bindingIds.add(binding.id);
      if (!instanceIds.has(binding.target.driverInstanceId)) {
        throw new HubError("UNKNOWN_DRIVER_INSTANCE", binding.target.driverInstanceId);
      }
      if (
        binding.batchWindowMs !== undefined &&
        (!Number.isSafeInteger(binding.batchWindowMs) || binding.batchWindowMs < 0)
      ) {
        throw new HubError("INVALID_BATCH_WINDOW", "batchWindowMs must be a non-negative safe integer");
      }
    }
  }

  private appendHistory(kind: string, subjectId: string | null, payload: unknown, now: string): void {
    this.db.raw
      .prepare("INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, subjectId, JSON.stringify(payload), now);
  }
}

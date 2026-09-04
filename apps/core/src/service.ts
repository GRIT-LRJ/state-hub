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
import { validateClaimValue, validateEventValue } from "./schema-validation.js";

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

function redactDiagnostic(value: unknown, key = ""): unknown {
  if (/token|secret|password|authorization|cookie|credential/iu.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        redactDiagnostic(entry, entryKey),
      ]),
    );
  }
  return value;
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
    if (!row) return undefined;
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
    scopeId: string,
    signalId: string,
    input: StateClaimInput,
    idempotencyKey?: string,
  ): AcceptedCommand {
    const validationError = validateClaimValue(this.db, producerId, signalId, input.value);
    if (validationError) throw new HubError("SOURCE_SCHEMA_VIOLATION", validationError, 422);
    return this.executeCommand(producerId, "claim.upsert", idempotencyKey, input, (commandId, revision, now) => {
      this.touchScope(producerId, scopeId, input.sourceType, now);
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
      this.recomputeStateful(commandId, revision, now);
      this.appendHistory("claim.upsert", claimKey(producerId, scopeId, signalId), { revision }, now);
    });
  }

  clearClaim(
    producerId: string,
    scopeId: string,
    signalId: string,
    idempotencyKey?: string,
  ): AcceptedCommand {
    return this.executeCommand(
      producerId,
      "claim.clear",
      idempotencyKey,
      { scopeId, signalId },
      (commandId, revision, now) => {
        const key = claimKey(producerId, scopeId, signalId);
        this.db.raw
          .prepare("DELETE FROM claims WHERE producer_id = ? AND scope_id = ? AND signal_id = ?")
          .run(producerId, scopeId, signalId);
        this.db.raw.prepare("DELETE FROM binding_transitions WHERE input_key = ?").run(key);
        this.recomputeStateful(commandId, revision, now);
        this.appendHistory("claim.clear", key, { revision }, now);
      },
    );
  }

  emitEvent(
    producerId: string,
    input: OccurrenceEventInput,
    idempotencyKey?: string,
  ): AcceptedCommand {
    const validationError = validateEventValue(this.db, producerId, input.type, input.value);
    if (validationError) throw new HubError("SOURCE_SCHEMA_VIOLATION", validationError, 422);
    return this.executeCommand(producerId, "event.emit", idempotencyKey ?? input.eventId, input, (commandId, revision, now) => {
      const duplicate = this.db.raw
        .prepare("SELECT 1 FROM occurrence_events WHERE producer_id = ? AND event_id = ?")
        .get(producerId, input.eventId);
      if (duplicate) return;
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
    });
  }

  replaceSnapshot(
    producerId: string,
    claims: SnapshotClaim[],
    idempotencyKey?: string,
  ): AcceptedCommand {
    const identities = new Set<string>();
    for (const claim of claims) {
      const identity = `${claim.scopeId}\u001f${claim.signalId}`;
      if (identities.has(identity)) throw new HubError("DUPLICATE_SNAPSHOT_CLAIM", identity);
      identities.add(identity);
      const validationError = validateClaimValue(this.db, producerId, claim.signalId, claim.value);
      if (validationError) throw new HubError("SOURCE_SCHEMA_VIOLATION", validationError, 422);
    }
    return this.executeCommand(producerId, "snapshot.replace", idempotencyKey, claims, (commandId, revision, now) => {
      this.db.raw.prepare("DELETE FROM claims WHERE producer_id = ?").run(producerId);
      this.db.raw
        .prepare("DELETE FROM binding_transitions WHERE input_key LIKE ?")
        .run(`${producerId}\u001f%`);
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
      this.recomputeStateful(commandId, revision, now);
      this.appendHistory("snapshot.replace", producerId, { claimCount: claims.length, revision }, now);
    });
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
      this.recomputeStateful(undefined, revision, now);
    });
    this.events.publish("snapshot.changed", this.snapshot());
  }

  setPaused(paused: boolean): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.raw
        .prepare("UPDATE settings SET value_json = ? WHERE key = 'outputsPaused'")
        .run(JSON.stringify(paused));
      const revision = this.db.nextRevision();
      this.recomputeStateful(undefined, revision, now);
      this.appendHistory(paused ? "outputs.paused" : "outputs.resumed", null, {}, now);
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
      this.recomputeStateful(undefined, revision, now);
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
      files: [
        { name: "runtime-summary.json", containsSecrets: false },
        { name: "config-redacted.json", containsSecrets: false },
        { name: "recent-history.json", containsSecrets: false },
      ],
      redaction: ["claim values", "token/secret/password/authorization/cookie/credential fields", "producer token hashes"],
    };
  }

  diagnosticBundle(): Record<string, unknown> {
    const snapshot = this.snapshot();
    const recentHistory = this.db.raw
      .prepare("SELECT kind, subject_id, payload_json, created_at FROM history ORDER BY id DESC LIMIT 500")
      .all() as Array<{ kind: string; subject_id: string | null; payload_json: string; created_at: string }>;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        revision: snapshot.revision,
        outputsPaused: snapshot.outputsPaused,
        claimCount: snapshot.claims.length,
        projections: snapshot.projections.map((projection) => redactDiagnostic(projection)),
        pendingDeliveries: snapshot.pendingDeliveries,
        deadLetters: snapshot.deadLetters,
      },
      config: redactDiagnostic(this.exportConfig()),
      history: recentHistory.map((row) => ({
        kind: row.kind,
        subjectId: row.subject_id,
        payload: redactDiagnostic(JSON.parse(row.payload_json) as unknown),
        createdAt: row.created_at,
      })),
      claims: snapshot.claims.map((claim) => ({
        producerId: claim.producerId,
        scopeId: claim.scopeId,
        signalId: claim.signalId,
        revision: claim.revision,
        urgency: claim.urgency,
        value: "[REDACTED]",
      })),
    };
  }

  cleanupHistory(now = new Date()): void {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.transaction(() => {
      this.db.raw.prepare("DELETE FROM history WHERE created_at < ?").run(cutoff);
      this.db.raw.prepare("DELETE FROM occurrence_events WHERE accepted_at < ?").run(cutoff);
      this.db.raw.prepare("DELETE FROM deliveries WHERE completed_at < ?").run(cutoff);
      this.db.raw.prepare("DELETE FROM commands WHERE completed_at < ?").run(cutoff);
      const sizeQuery = this.db.raw.prepare(
        "SELECT COALESCE(sum(length(payload_json) + length(kind) + COALESCE(length(subject_id), 0)), 0) AS bytes FROM history",
      );
      let size = (sizeQuery.get() as { bytes: number }).bytes;
      while (size > 100 * 1024 * 1024) {
        const removed = this.db.raw
          .prepare("DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY id ASC LIMIT 1000)")
          .run();
        if (removed.changes === 0) break;
        size = (sizeQuery.get() as { bytes: number }).bytes;
      }
    });
  }

  private executeCommand(
    producerId: string,
    kind: CommandKind,
    idempotencyKey: string | undefined,
    request: unknown,
    work: (commandId: string, revision: number, now: string) => void,
  ): AcceptedCommand {
    const requestHash = createHash("sha256").update(stableStringify(request)).digest("hex");
    const accepted = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.db.raw
          .prepare("SELECT * FROM commands WHERE producer_id = ? AND idempotency_key = ?")
          .get(producerId, idempotencyKey) as CommandRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new HubError("IDEMPOTENCY_CONFLICT", "The idempotency key was used for a different request", 409);
          }
          return { commandId: existing.id, status: "accepted" as const, acceptedAt: existing.accepted_at };
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
      const revision = this.db.nextRevision();
      work(commandId, revision, now);
      this.db.raw
        .prepare("UPDATE commands SET status = 'applied', completed_at = ? WHERE id = ?")
        .run(now, commandId);
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

  private recomputeStateful(commandId: string | undefined, revision: number, now: string): void {
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
    let next = arbitrate(candidates, revision);
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
          revision,
        });
      }
    }
    for (const projection of byKey.values()) {
      const previous = old.find((item) => item.resourceKey === projection.resourceKey);
      const changed = !previous || actionSignature(previous.action) !== actionSignature(projection.action);
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
          revision,
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
          revision,
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
      this.enqueueDelivery(
        commandId,
        binding.target.driverInstanceId,
        binding.target.resourceChannel,
        binding.target.actionKind,
        buildAction(binding, event.value),
        plusMilliseconds(now, binding.batchWindowMs ?? 0),
      );
    }
  }

  private enqueueDelivery(
    commandId: string | undefined,
    driverInstanceId: string,
    channel: string,
    kind: ActionKind,
    action: Projection["action"],
    availableAt: string,
    projectionRevision?: number,
  ): void {
    const deadlineAt =
      kind === "append-only"
        ? plusMilliseconds(availableAt, 24 * 60 * 60 * 1000)
        : kind === "queued-effect"
          ? plusMilliseconds(availableAt, 30_000)
          : null;
    this.db.raw
      .prepare(
        `INSERT INTO deliveries(
           id, command_id, driver_instance_id, resource_channel, action_kind, action_json,
           projection_revision, status, available_at, deadline_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        commandId ?? null,
        driverInstanceId,
        channel,
        kind,
        action ? JSON.stringify(action) : null,
        projectionRevision ?? null,
        availableAt,
        deadlineAt,
        new Date().toISOString(),
      );
  }

  private validateConfig(config: PublishedConfig): void {
    const instanceIds = new Set<string>();
    const physicalKeys = new Set<string>();
    for (const instance of config.driverInstances) {
      if (instanceIds.has(instance.id)) throw new HubError("DUPLICATE_DRIVER_INSTANCE", instance.id);
      instanceIds.add(instance.id);
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
    }
  }

  private appendHistory(kind: string, subjectId: string | null, payload: unknown, now: string): void {
    this.db.raw
      .prepare("INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, subjectId, JSON.stringify(payload), now);
  }
}

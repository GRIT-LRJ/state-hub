import type {
  ActionKind,
  ActionPayload,
  DriverActionBatchItem,
  DriverActionRequest,
  DriverActionResult,
} from "@state-hub/protocol";
import { resourceKey } from "@state-hub/domain";
import { randomUUID } from "node:crypto";
import type { StateHubDatabase } from "./database.js";
import type { Driver } from "./drivers.js";
import type { HubEventBus } from "./events.js";
import { safeDeliveryErrorSummary } from "./delivery-diagnostics.js";

interface DeliveryRow {
  id: string;
  command_id: string | null;
  producer_id: string | null;
  event_id: string | null;
  event_revision: number | null;
  driver_instance_id: string;
  resource_channel: string;
  action_kind: ActionKind;
  action_json: string | null;
  projection_revision: number | null;
  batch_key: string | null;
  batch_id: string | null;
  status: string;
  attempt_count: number;
  deadline_at: string | null;
  lease_until: string | null;
}

interface ProjectionRow {
  driver_instance_id: string;
  resource_channel: string;
  action_json: string | null;
  revision: number;
}

interface DriverProvider {
  get(instanceId: string): Driver | undefined;
}

export interface DeliveryDispatcherOptions {
  leaseDurationMs?: number;
  now?: () => Date;
  appendOnlyMaxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_APPEND_ONLY_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;

export class DeliveryDispatcher {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopping = false;
  readonly #idleWaiters: Array<() => void> = [];
  readonly #leaseDurationMs: number;
  readonly #now: () => Date;
  readonly #appendOnlyMaxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;

  constructor(
    private readonly db: StateHubDatabase,
    private readonly drivers: DriverProvider,
    private readonly events: HubEventBus,
    options: number | DeliveryDispatcherOptions = {},
  ) {
    const normalized = typeof options === "number" ? { leaseDurationMs: options } : options;
    this.#leaseDurationMs = normalized.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#now = normalized.now ?? (() => new Date());
    this.#appendOnlyMaxAttempts =
      normalized.appendOnlyMaxAttempts ?? DEFAULT_APPEND_ONLY_MAX_ATTEMPTS;
    this.#retryBaseMs = normalized.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryMaxMs = normalized.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  recoverInterrupted(): number {
    const completedAt = this.nowIso();
    const paused = this.outputsPaused();
    const suppressed: Array<{ delivery: DeliveryRow; detail: string }> = [];
    const recovered: string[] = [];

    this.db.transaction(() => {
      const interruptedEffects = this.db.raw
        .prepare(
          `SELECT * FROM deliveries
           WHERE status IN ('pending', 'leased')
             AND (action_kind = 'queued-effect' OR (? = 1 AND action_kind = 'append-only'))`,
        )
        .all(paused ? 1 : 0) as DeliveryRow[];
      for (const delivery of interruptedEffects) {
        suppressed.push({
          delivery,
          detail: delivery.action_kind === "queued-effect"
            ? "Queued effect crossed a Core recovery boundary"
            : "Append-only delivery was suppressed while outputs were paused",
        });
      }

      const staleStateful = this.db.raw
        .prepare(
          `SELECT d.* FROM deliveries d
           LEFT JOIN projections p
             ON p.driver_instance_id = d.driver_instance_id
            AND p.resource_channel = d.resource_channel
           WHERE d.action_kind = 'stateful'
             AND d.status IN ('pending', 'leased')
             AND (d.projection_revision IS NULL OR p.revision IS NULL OR d.projection_revision <> p.revision)`,
        )
        .all() as DeliveryRow[];
      for (const delivery of staleStateful) {
        suppressed.push({ delivery, detail: "Stateful delivery is not the current projection revision" });
      }

      for (const { delivery, detail } of suppressed) {
        this.db.raw
          .prepare(
            `UPDATE deliveries
             SET status = 'suppressed', completed_at = ?, lease_until = NULL, last_error = ?
             WHERE id = ? AND status IN ('pending', 'leased')`,
          )
          .run(completedAt, detail, delivery.id);
        this.recordAttempt(delivery, completedAt, completedAt, "suppressed", detail);
      }

      this.enqueueCurrentStateful(completedAt, recovered);
    });
    for (const { delivery, detail } of suppressed) {
      this.events.publish("delivery.suppressed", {
        deliveryId: delivery.id,
        detail,
      });
    }
    for (const deliveryId of recovered) {
      this.events.publish("delivery.recovered", { deliveryId, actionKind: "stateful" });
    }
    return suppressed.length + recovered.length;
  }

  recoverCurrentStateful(driverInstanceId?: string): number {
    const now = this.nowIso();
    const recovered: string[] = [];
    this.db.transaction(() => this.enqueueCurrentStateful(now, recovered, driverInstanceId));
    for (const deliveryId of recovered) {
      this.events.publish("delivery.recovered", { deliveryId, actionKind: "stateful" });
    }
    return recovered.length;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    this.#timer = setInterval(() => void this.drain(), 50);
    this.#timer.unref();
    void this.drain();
  }

  stop(): void {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async waitForIdle(): Promise<void> {
    if (!this.#running) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  async drain(): Promise<void> {
    if (this.#running || this.#stopping) return;
    this.#running = true;
    try {
      for (let index = 0; index < 100 && !this.#stopping; index += 1) {
        const deliveries = this.claimNext();
        if (!deliveries) break;
        await this.execute(deliveries);
        // Suppressed/virtual deliveries can resolve synchronously. Yield between
        // small groups so a backlog cannot starve committed HTTP responses.
        if (index % 8 === 7) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.#running = false;
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  private claimNext(): DeliveryRow[] | undefined {
    const now = this.#now();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + this.#leaseDurationMs).toISOString();
    const exhausted: Array<{ deliveryId: string; detail: string }> = [];
    const claimed = this.db.transaction(() => {
      const anchor = this.db.raw
        .prepare(
          `SELECT * FROM deliveries
           WHERE (status = 'pending' AND available_at <= ?)
              OR (status = 'leased' AND lease_until <= ?)
           ORDER BY available_at, created_at, id LIMIT 1`,
        )
        .get(nowIso, nowIso) as DeliveryRow | undefined;
      if (!anchor) return undefined;
      const rows = anchor.action_kind === "append-only" && anchor.batch_id
        ? this.db.raw
            .prepare(
              `SELECT * FROM deliveries
               WHERE batch_id = ?
                 AND ((status = 'pending' AND available_at <= ?)
                   OR (status = 'leased' AND lease_until <= ?))
               ORDER BY event_revision, created_at, id`,
            )
            .all(anchor.batch_id, nowIso, nowIso) as DeliveryRow[]
        : [anchor];
      const eligible: DeliveryRow[] = [];
      for (const row of rows) {
        const limit = row.action_kind === "append-only" ? this.#appendOnlyMaxAttempts
          : row.action_kind === "stateful" ? 10 : undefined;
        if (limit === undefined || row.attempt_count < limit) {
          eligible.push(row);
          continue;
        }
        const detail = `Retry budget exhausted after ${limit} attempts during lease recovery`;
        const update = this.db.raw.prepare(
          `UPDATE deliveries
           SET status = 'dead-letter', completed_at = ?, lease_until = NULL, last_error = ?
           WHERE id = ? AND status = ? AND lease_until IS ?`,
        ).run(nowIso, detail, row.id, row.status, row.lease_until);
        if (update.changes === 0) continue;
        this.recordAttempt(row, nowIso, nowIso, "dead-letter", detail);
        exhausted.push({ deliveryId: row.id, detail });
      }
      const claim = this.db.raw.prepare(
        "UPDATE deliveries SET status = 'leased', lease_until = ?, attempt_count = attempt_count + 1 WHERE id = ?",
      );
      for (const row of eligible) claim.run(leaseUntil, row.id);
      return eligible.map((row) => ({
        ...row,
        attempt_count: row.attempt_count + 1,
        lease_until: leaseUntil,
      }));
    });
    for (const { deliveryId, detail } of exhausted) {
      this.events.publish("delivery.dead-letter", { deliveryId, detail });
    }
    return claimed;
  }

  private async execute(deliveries: DeliveryRow[]): Promise<void> {
    const startedAt = this.nowIso();
    const first = deliveries[0];
    if (!first) return;
    if (!this.isCompatibleBatch(deliveries)) {
      this.finish(deliveries, startedAt, "dead-letter", "Persisted append-only batch is incompatible");
      return;
    }
    if (first.action_kind === "stateful") {
      if (first.projection_revision === null) {
        this.finish(deliveries, startedAt, "suppressed", "Stateful delivery has no projection revision");
        return;
      }
      const current = this.db.raw
        .prepare("SELECT revision FROM projections WHERE resource_key = ?")
        .get(resourceKey(first.driver_instance_id, first.resource_channel)) as { revision: number } | undefined;
      if (!current || current.revision !== first.projection_revision) {
        this.finish(deliveries, startedAt, "suppressed", "A newer stateful projection exists");
        return;
      }
    }
    if (first.action_kind !== "stateful" && this.outputsPaused()) {
      this.finish(deliveries, startedAt, "suppressed", "Outputs are paused");
      return;
    }

    const nowMs = this.#now().getTime();
    const expired = deliveries.filter(
      (delivery) => delivery.deadline_at && Date.parse(delivery.deadline_at) <= nowMs,
    );
    if (expired.length > 0) {
      this.finish(expired, startedAt, "dead-letter", "Delivery TTL expired");
    }
    const active = deliveries.filter((delivery) => !expired.includes(delivery));
    if (active.length === 0) return;

    const driver = this.drivers.get(first.driver_instance_id);
    if (!driver) {
      this.finish(active, startedAt, "dead-letter", "Driver instance is missing or disabled");
      return;
    }
    const request = this.buildRequest(active);
    let result: DriverActionResult;
    try {
      result = await driver.execute(request);
    } catch {
      result = { status: "retry", detail: "Driver error details withheld" };
    }
    const safeDetail = safeDeliveryErrorSummary(result.detail);
    if (result.status !== "retry") {
      this.finish(active, startedAt, result.status, safeDetail);
      return;
    }

    const retryable = active.filter((delivery) =>
      (delivery.action_kind === "append-only" && delivery.attempt_count < this.#appendOnlyMaxAttempts) ||
      (delivery.action_kind === "stateful" && delivery.attempt_count < 10),
    );
    const exhausted = active.filter((delivery) => !retryable.includes(delivery));
    if (exhausted.length > 0) {
      const retryBudget = first.action_kind === "append-only" ? this.#appendOnlyMaxAttempts : 10;
      const detail = deliveryFailureDetail(
        `Retry budget exhausted after ${retryBudget} attempts`,
        safeDetail,
      );
      this.finish(exhausted, startedAt, "dead-letter", detail);
    }
    if (retryable.length === 0) return;

    const exponentialDelay = Math.min(
      this.#retryMaxMs,
      this.#retryBaseMs * 2 ** (first.attempt_count - 1),
    );
    const requestedDelay =
      result.retryAfterMs !== undefined && Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0
        ? result.retryAfterMs
        : exponentialDelay;
    const delay = Math.min(this.#retryMaxMs, Math.max(0, requestedDelay));
    this.reschedule(retryable, startedAt, delay, safeDetail);
  }

  private buildRequest(deliveries: DeliveryRow[]): DriverActionRequest {
    const first = deliveries[0];
    if (!first) throw new Error("Cannot build an empty delivery request");
    const batch = first.batch_id
      ? deliveries.map((delivery): DriverActionBatchItem => ({
          deliveryId: delivery.id,
          ...(delivery.producer_id ? { producerId: delivery.producer_id } : {}),
          ...(delivery.event_id ? { eventId: delivery.event_id } : {}),
          ...(delivery.event_revision === null ? {} : { eventRevision: delivery.event_revision }),
          action: decodeAction(delivery.action_json),
          ...(delivery.deadline_at ? { deadlineAt: delivery.deadline_at } : {}),
        }))
      : undefined;
    return {
      deliveryId: first.id,
      ...(first.producer_id ? { producerId: first.producer_id } : {}),
      ...(first.event_id ? { eventId: first.event_id } : {}),
      ...(first.event_revision === null ? {} : { eventRevision: first.event_revision }),
      driverInstanceId: first.driver_instance_id,
      resourceChannel: first.resource_channel,
      actionKind: first.action_kind,
      action: decodeAction(first.action_json),
      ...(first.projection_revision === null ? {} : { projectionRevision: first.projection_revision }),
      ...(first.deadline_at ? { deadlineAt: first.deadline_at } : {}),
      ...(first.batch_id ? { batchId: first.batch_id } : {}),
      ...(batch ? { batch } : {}),
    };
  }

  private isCompatibleBatch(deliveries: DeliveryRow[]): boolean {
    const first = deliveries[0];
    if (!first || deliveries.length === 1) return true;
    return first.action_kind === "append-only" && Boolean(first.batch_id) && deliveries.every((delivery) =>
      delivery.batch_id === first.batch_id &&
      delivery.driver_instance_id === first.driver_instance_id &&
      delivery.resource_channel === first.resource_channel &&
      delivery.action_kind === first.action_kind,
    );
  }

  private reschedule(
    deliveries: DeliveryRow[],
    startedAt: string,
    delayMs: number,
    detail?: string,
  ): void {
    const nowMs = this.#now().getTime();
    const rescheduled: Array<{ deliveryId: string; availableAt: string }> = [];
    this.db.transaction(() => {
      for (const delivery of deliveries) {
        const deadlineMs = delivery.deadline_at ? Date.parse(delivery.deadline_at) : Number.POSITIVE_INFINITY;
        const availableAt = new Date(Math.min(nowMs + delayMs, deadlineMs)).toISOString();
        const update = this.db.raw
          .prepare(
            `UPDATE deliveries
             SET status = 'pending', available_at = ?, lease_until = NULL, last_error = ?
             WHERE id = ? AND status = 'leased' AND lease_until = ?`,
          )
          .run(availableAt, detail ?? null, delivery.id, delivery.lease_until);
        if (update.changes === 0) continue;
        this.recordAttempt(delivery, startedAt, this.nowIso(), "retry", detail);
        rescheduled.push({ deliveryId: delivery.id, availableAt });
      }
    });
    for (const item of rescheduled) {
      this.events.publish("delivery.retry-scheduled", item);
    }
  }

  private finish(
    deliveries: DeliveryRow[],
    startedAt: string,
    status: "delivered" | "dead-letter" | "suppressed",
    detail?: string,
  ): void {
    const completedAt = this.nowIso();
    const finished: string[] = [];
    this.db.transaction(() => {
      for (const delivery of deliveries) {
        const update = this.db.raw
          .prepare(
            `UPDATE deliveries
             SET status = ?, completed_at = ?, lease_until = NULL, last_error = ?
             WHERE id = ? AND status = 'leased' AND lease_until = ?`,
          )
          .run(status, completedAt, detail ?? null, delivery.id, delivery.lease_until);
        if (update.changes === 0) continue;
        this.recordAttempt(delivery, startedAt, completedAt, status, detail);
        finished.push(delivery.id);
      }
    });
    for (const deliveryId of finished) {
      this.events.publish(`delivery.${status}`, { deliveryId, detail });
    }
  }

  private outputsPaused(): boolean {
    const row = this.db.raw.prepare("SELECT value_json FROM settings WHERE key = 'outputsPaused'").get() as {
      value_json: string;
    };
    return JSON.parse(row.value_json) as boolean;
  }

  private enqueueCurrentStateful(now: string, recovered: string[], driverInstanceId?: string): void {
    const projections = (driverInstanceId
      ? this.db.raw
          .prepare(
            `SELECT driver_instance_id, resource_channel, action_json, revision
             FROM projections WHERE driver_instance_id = ?`,
          )
          .all(driverInstanceId)
      : this.db.raw
          .prepare("SELECT driver_instance_id, resource_channel, action_json, revision FROM projections")
          .all()) as ProjectionRow[];
    for (const projection of projections) {
      const unfinished = this.db.raw
        .prepare(
          `SELECT 1 FROM deliveries
           WHERE driver_instance_id = ? AND resource_channel = ? AND action_kind = 'stateful'
             AND projection_revision = ? AND status IN ('pending', 'leased')
           LIMIT 1`,
        )
        .get(projection.driver_instance_id, projection.resource_channel, projection.revision);
      if (unfinished) continue;
      const deliveryId = randomUUID();
      this.db.raw
        .prepare(
          `INSERT INTO deliveries(
             id, command_id, driver_instance_id, resource_channel, action_kind, action_json,
             projection_revision, status, available_at, deadline_at, created_at
           ) VALUES (?, NULL, ?, ?, 'stateful', ?, ?, 'pending', ?, NULL, ?)`,
        )
        .run(
          deliveryId,
          projection.driver_instance_id,
          projection.resource_channel,
          projection.action_json,
          projection.revision,
          now,
          now,
        );
      recovered.push(deliveryId);
    }
  }

  private recordAttempt(
    delivery: DeliveryRow,
    startedAt: string,
    completedAt: string,
    status: string,
    detail?: string,
  ): void {
    this.db.raw
      .prepare(
        `INSERT INTO delivery_attempts(delivery_id, attempt, started_at, completed_at, status, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(delivery.id, delivery.attempt_count, startedAt, completedAt, status, detail ?? null);
  }

  private nowIso(): string {
    return this.#now().toISOString();
  }
}

function decodeAction(value: string | null): ActionPayload | null {
  return value ? (JSON.parse(value) as ActionPayload) : null;
}

function deliveryFailureDetail(summary: string, cause?: string): string {
  return cause ? `${summary}: ${cause}` : summary;
}

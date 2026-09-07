import type { ActionKind, ActionPayload, DriverActionRequest } from "@state-hub/protocol";
import { resourceKey } from "@state-hub/domain";
import { randomUUID } from "node:crypto";
import type { StateHubDatabase } from "./database.js";
import type { DriverRegistry } from "./drivers.js";
import type { HubEventBus } from "./events.js";

interface DeliveryRow {
  id: string;
  driver_instance_id: string;
  resource_channel: string;
  action_kind: ActionKind;
  action_json: string | null;
  projection_revision: number | null;
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

export class DeliveryDispatcher {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly db: StateHubDatabase,
    private readonly drivers: DriverRegistry,
    private readonly events: HubEventBus,
    private readonly leaseDurationMs = 30_000,
  ) {}

  recoverInterrupted(): number {
    const completedAt = new Date().toISOString();
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
        this.recordAttempt(delivery, completedAt, "suppressed", detail);
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
    const now = new Date().toISOString();
    const recovered: string[] = [];
    this.db.transaction(() => this.enqueueCurrentStateful(now, recovered, driverInstanceId));
    for (const deliveryId of recovered) {
      this.events.publish("delivery.recovered", { deliveryId, actionKind: "stateful" });
    }
    return recovered.length;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.drain(), 50);
    this.#timer.unref();
    void this.drain();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let index = 0; index < 100; index += 1) {
        const delivery = this.claimNext();
        if (!delivery) break;
        await this.execute(delivery);
      }
    } finally {
      this.#running = false;
    }
  }

  private claimNext(): DeliveryRow | undefined {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + this.leaseDurationMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db.raw
        .prepare(
          `SELECT * FROM deliveries
           WHERE (status = 'pending' AND available_at <= ?)
              OR (status = 'leased' AND lease_until <= ?)
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(nowIso, nowIso) as DeliveryRow | undefined;
      if (!row) return undefined;
      this.db.raw
        .prepare("UPDATE deliveries SET status = 'leased', lease_until = ?, attempt_count = attempt_count + 1 WHERE id = ?")
        .run(leaseUntil, row.id);
      return { ...row, attempt_count: row.attempt_count + 1, lease_until: leaseUntil };
    });
  }

  private async execute(delivery: DeliveryRow): Promise<void> {
    const startedAt = new Date().toISOString();
    if (delivery.action_kind === "stateful") {
      if (delivery.projection_revision === null) {
        this.finish(delivery, startedAt, "suppressed", "Stateful delivery has no projection revision");
        return;
      }
      const current = this.db.raw
        .prepare("SELECT revision FROM projections WHERE resource_key = ?")
        .get(resourceKey(delivery.driver_instance_id, delivery.resource_channel)) as { revision: number } | undefined;
      if (!current || current.revision !== delivery.projection_revision) {
        this.finish(delivery, startedAt, "suppressed", "A newer stateful projection exists");
        return;
      }
    }
    if (delivery.action_kind !== "stateful" && this.outputsPaused()) {
      this.finish(delivery, startedAt, "suppressed", "Outputs are paused");
      return;
    }
    if (delivery.deadline_at && Date.parse(delivery.deadline_at) <= Date.now()) {
      this.finish(delivery, startedAt, "dead-letter", "Delivery TTL expired");
      return;
    }
    const driver = this.drivers.get(delivery.driver_instance_id);
    if (!driver) {
      this.finish(delivery, startedAt, "dead-letter", "Driver instance is missing or disabled");
      return;
    }
    const request: DriverActionRequest = {
      deliveryId: delivery.id,
      driverInstanceId: delivery.driver_instance_id,
      resourceChannel: delivery.resource_channel,
      actionKind: delivery.action_kind,
      action: delivery.action_json ? (JSON.parse(delivery.action_json) as ActionPayload) : null,
      ...(delivery.projection_revision === null ? {} : { projectionRevision: delivery.projection_revision }),
      ...(delivery.deadline_at ? { deadlineAt: delivery.deadline_at } : {}),
    };
    let result;
    try {
      result = await driver.execute(request);
    } catch (error) {
      result = { status: "retry" as const, detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.status !== "retry") {
      this.finish(delivery, startedAt, result.status, result.detail);
      return;
    }
    const retryAllowed =
      (delivery.action_kind === "append-only" && delivery.attempt_count < 8) ||
      (delivery.action_kind === "stateful" && delivery.attempt_count < 10);
    if (!retryAllowed) {
      this.finish(delivery, startedAt, "dead-letter", result.detail ?? "Retry budget exhausted");
      return;
    }
    const delay = result.retryAfterMs ?? Math.min(30_000, 250 * 2 ** (delivery.attempt_count - 1));
    const availableAt = new Date(Date.now() + delay).toISOString();
    const rescheduled = this.db.transaction(() => {
      const update = this.db.raw
        .prepare(
          `UPDATE deliveries
           SET status = 'pending', available_at = ?, lease_until = NULL, last_error = ?
           WHERE id = ? AND status = 'leased' AND lease_until = ?`,
        )
        .run(availableAt, result.detail ?? null, delivery.id, delivery.lease_until);
      if (update.changes === 0) return false;
      this.recordAttempt(delivery, startedAt, "retry", result.detail);
      return true;
    });
    if (rescheduled) this.events.publish("delivery.retry-scheduled", { deliveryId: delivery.id, availableAt });
  }

  private finish(
    delivery: DeliveryRow,
    startedAt: string,
    status: "delivered" | "dead-letter" | "suppressed",
    detail?: string,
  ): void {
    const completedAt = new Date().toISOString();
    const finished = this.db.transaction(() => {
      const update = this.db.raw
        .prepare(
          `UPDATE deliveries
           SET status = ?, completed_at = ?, lease_until = NULL, last_error = ?
           WHERE id = ? AND status = 'leased' AND lease_until = ?`,
        )
        .run(status, completedAt, detail ?? null, delivery.id, delivery.lease_until);
      if (update.changes === 0) return false;
      this.recordAttempt(delivery, startedAt, status, detail);
      return true;
    });
    if (finished) this.events.publish(`delivery.${status}`, { deliveryId: delivery.id, detail });
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

  private recordAttempt(delivery: DeliveryRow, startedAt: string, status: string, detail?: string): void {
    this.db.raw
      .prepare(
        `INSERT INTO delivery_attempts(delivery_id, attempt, started_at, completed_at, status, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(delivery.id, delivery.attempt_count, startedAt, new Date().toISOString(), status, detail ?? null);
  }
}

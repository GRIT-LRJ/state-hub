import type { ActionKind, ActionPayload, DriverActionRequest } from "@state-hub/protocol";
import { resourceKey } from "@state-hub/domain";
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
}

export class DeliveryDispatcher {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly db: StateHubDatabase,
    private readonly drivers: DriverRegistry,
    private readonly events: HubEventBus,
  ) {}

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
    const leaseUntil = new Date(now.getTime() + 30_000).toISOString();
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
      return { ...row, attempt_count: row.attempt_count + 1 };
    });
  }

  private async execute(delivery: DeliveryRow): Promise<void> {
    const startedAt = new Date().toISOString();
    if (delivery.action_kind === "stateful" && delivery.projection_revision !== null) {
      const current = this.db.raw
        .prepare("SELECT revision FROM projections WHERE resource_key = ?")
        .get(resourceKey(delivery.driver_instance_id, delivery.resource_channel)) as { revision: number } | undefined;
      if (!current || current.revision !== delivery.projection_revision) {
        this.finish(delivery, startedAt, "suppressed", "A newer stateful projection exists");
        return;
      }
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
    this.db.transaction(() => {
      this.recordAttempt(delivery, startedAt, "retry", result.detail);
      this.db.raw
        .prepare("UPDATE deliveries SET status = 'pending', available_at = ?, lease_until = NULL, last_error = ? WHERE id = ?")
        .run(availableAt, result.detail ?? null, delivery.id);
    });
    this.events.publish("delivery.retry-scheduled", { deliveryId: delivery.id, availableAt });
  }

  private finish(
    delivery: DeliveryRow,
    startedAt: string,
    status: "delivered" | "dead-letter" | "suppressed",
    detail?: string,
  ): void {
    const completedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.recordAttempt(delivery, startedAt, status, detail);
      this.db.raw
        .prepare("UPDATE deliveries SET status = ?, completed_at = ?, lease_until = NULL, last_error = ? WHERE id = ?")
        .run(status, completedAt, detail ?? null, delivery.id);
    });
    this.events.publish(`delivery.${status}`, { deliveryId: delivery.id, detail });
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Binding,
  DriverActionRequest,
  DriverActionResult,
  OccurrenceEventInput,
} from "@state-hub/protocol";
import { registerProducer } from "./auth.js";
import { StateHubDatabase } from "./database.js";
import { DeliveryDispatcher } from "./dispatcher.js";
import type { Driver } from "./drivers.js";
import { HubEventBus } from "./events.js";
import { StateHubService } from "./service.js";

class ProgrammableDriver implements Driver {
  readonly requests: DriverActionRequest[] = [];

  constructor(private readonly executeResult: (attempt: number) => DriverActionResult) {}

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    this.requests.push(request);
    return this.executeResult(this.requests.length);
  }
}

function appendBinding(id: string, eventType: string): Binding {
  return {
    id,
    name: id,
    enabled: true,
    selector: { producerId: "append-producer", eventType, scopePattern: "*" },
    conditions: [],
    mapping: { sequence: { kind: "pointer", pointer: "/sequence" } },
    target: {
      driverInstanceId: "append-driver",
      resourceChannel: "audit",
      actionKind: "append-only",
      actionName: "notify",
    },
    batchWindowMs: 100,
  };
}

function insertAppendDelivery(
  db: StateHubDatabase,
  {
    id = "delivery",
    availableAt,
    deadlineAt,
  }: { id?: string; availableAt: string; deadlineAt: string },
): void {
  db.raw
    .prepare(
      `INSERT INTO deliveries(
         id, command_id, event_id, driver_instance_id, resource_channel, action_kind,
         action_json, projection_revision, batch_key, batch_id, status, attempt_count,
         available_at, deadline_at, created_at
       ) VALUES (?, NULL, ?, 'append-driver', 'audit', 'append-only', ?, NULL, NULL, NULL,
                 'pending', 0, ?, ?, ?)`,
    )
    .run(
      id,
      `event-${id}`,
      JSON.stringify({ name: "append", params: { id } }),
      availableAt,
      deadlineAt,
      availableAt,
    );
}

describe("append-only dispatcher", () => {
  let db: StateHubDatabase;
  let events: HubEventBus;

  beforeEach(() => {
    db = new StateHubDatabase(":memory:");
    events = new HubEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("waits for an in-flight delivery and does not claim another after stopping", async () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let complete: (result: DriverActionResult) => void = () => undefined;
    const requests: DriverActionRequest[] = [];
    const driver: Driver = {
      execute: async (request) => {
        requests.push(request);
        started();
        return await new Promise<DriverActionResult>((resolve) => { complete = resolve; });
      },
    };
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => new Date(nowMs),
    });
    for (const id of ["first", "second"]) {
      insertAppendDelivery(db, {
        id, availableAt: new Date(nowMs).toISOString(),
        deadlineAt: new Date(nowMs + 60_000).toISOString(),
      });
    }
    const drain = dispatcher.drain();
    await entered;
    dispatcher.stop();
    let idle = false;
    const waiting = dispatcher.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    complete({ status: "delivered" });
    await Promise.all([drain, waiting]);
    expect(requests).toHaveLength(1);
    expect(db.raw.prepare("SELECT status FROM deliveries WHERE id = 'first'").get())
      .toMatchObject({ status: "delivered" });
    expect(db.raw.prepare("SELECT status FROM deliveries WHERE id = 'second'").get())
      .toMatchObject({ status: "pending" });
  });

  it("uses bounded exponential backoff and dead-letters after the retry budget", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const driver = new ProgrammableDriver(() => ({ status: "retry", detail: "temporary outage" }));
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => new Date(nowMs),
      appendOnlyMaxAttempts: 10,
    });
    insertAppendDelivery(db, {
      availableAt: new Date(nowMs).toISOString(),
      deadlineAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
    });

    const observedDelays: number[] = [];
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await dispatcher.drain();
      const row = db.raw
        .prepare("SELECT status, available_at, attempt_count, last_error FROM deliveries WHERE id = 'delivery'")
        .get() as { status: string; available_at: string; attempt_count: number; last_error: string | null };
      expect(row.attempt_count).toBe(attempt);
      if (attempt < 10) {
        expect(row.status).toBe("pending");
        const nextMs = Date.parse(row.available_at);
        observedDelays.push(nextMs - nowMs);
        nowMs = nextMs;
      } else {
        expect(row.status).toBe("dead-letter");
        expect(row.last_error).toContain("Retry budget exhausted after 10 attempts");
      }
    }

    expect(observedDelays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(driver.requests).toHaveLength(10);
    expect(db.raw.prepare(
      "SELECT status, count(*) AS count FROM delivery_attempts GROUP BY status ORDER BY status",
    ).all()).toEqual([
      { status: "dead-letter", count: 1 },
      { status: "retry", count: 9 },
    ]);
  });

  it("allows exactly the final attempt, then delivers or dead-letters without an extra call", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const driver = new ProgrammableDriver((attempt) => attempt === 1
      ? { status: "delivered" }
      : { status: "retry", detail: "unavailable" });
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => now,
      appendOnlyMaxAttempts: 2,
    });
    for (const id of ["first", "second"]) {
      insertAppendDelivery(db, {
        id,
        availableAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
      });
      db.raw.prepare("UPDATE deliveries SET attempt_count = 1 WHERE id = ?").run(id);
    }

    await dispatcher.drain();

    expect(driver.requests.map((request) => request.deliveryId)).toEqual(["first", "second"]);
    expect(db.raw.prepare("SELECT id, status, attempt_count FROM deliveries ORDER BY id").all()).toEqual([
      { id: "first", status: "delivered", attempt_count: 2 },
      { id: "second", status: "dead-letter", attempt_count: 2 },
    ]);
  });

  it("does not invoke the driver after reclaiming an exhausted lease", async () => {
    const now = new Date("2026-01-01T00:00:01.000Z");
    const driver = new ProgrammableDriver(() => ({ status: "delivered" }));
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => now,
      appendOnlyMaxAttempts: 2,
    });
    insertAppendDelivery(db, {
      availableAt: new Date(now.getTime() - 2_000).toISOString(),
      deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    db.raw.prepare("UPDATE deliveries SET status = 'leased', attempt_count = 2, lease_until = ? WHERE id = 'delivery'")
      .run(new Date(now.getTime() - 1_000).toISOString());

    await dispatcher.drain();

    expect(driver.requests).toHaveLength(0);
    expect(db.raw.prepare("SELECT status, attempt_count FROM deliveries WHERE id = 'delivery'").get()).toEqual({
      status: "dead-letter",
      attempt_count: 2,
    });
  });

  it("excludes exhausted members from a recovered batch before the external call", async () => {
    const now = new Date("2026-01-01T00:00:01.000Z");
    const driver = new ProgrammableDriver(() => ({ status: "delivered" }));
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => now,
      appendOnlyMaxAttempts: 2,
    });
    for (const id of ["exhausted", "eligible"]) {
      insertAppendDelivery(db, {
        id,
        availableAt: new Date(now.getTime() - 2_000).toISOString(),
        deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
      });
      db.raw.prepare("UPDATE deliveries SET batch_id = 'batch' WHERE id = ?").run(id);
    }
    db.raw.prepare("UPDATE deliveries SET status = 'leased', attempt_count = 2, lease_until = ? WHERE id = 'exhausted'")
      .run(new Date(now.getTime() - 1_000).toISOString());

    await dispatcher.drain();

    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.batch?.map((item) => item.deliveryId)).toEqual(["eligible"]);
    expect(db.raw.prepare("SELECT id, status, attempt_count FROM deliveries ORDER BY id").all()).toEqual([
      { id: "eligible", status: "delivered", attempt_count: 1 },
      { id: "exhausted", status: "dead-letter", attempt_count: 2 },
    ]);
  });

  it("fences a late result from the old lease owner after a new owner completes", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    let releaseFirst: (result: DriverActionResult) => void = () => { throw new Error("First call was not claimed"); };
    const firstResult = new Promise<DriverActionResult>((resolve) => { releaseFirst = resolve; });
    const driver: Driver & { requests: DriverActionRequest[] } = {
      requests: [],
      async execute(request) {
        this.requests.push(request);
        return this.requests.length === 1 ? await firstResult : { status: "delivered" };
      },
    };
    const options = { now: () => new Date(nowMs), leaseDurationMs: 100, appendOnlyMaxAttempts: 2 };
    const oldOwner = new DeliveryDispatcher(db, { get: () => driver }, events, options);
    const newOwner = new DeliveryDispatcher(db, { get: () => driver }, events, options);
    insertAppendDelivery(db, {
      availableAt: new Date(nowMs).toISOString(),
      deadlineAt: new Date(nowMs + 60_000).toISOString(),
    });

    const oldDrain = oldOwner.drain();
    expect(driver.requests).toHaveLength(1);
    nowMs += 101;
    await newOwner.drain();
    releaseFirst({ status: "retry", detail: "stale result" });
    await oldDrain;

    expect(driver.requests).toHaveLength(2);
    expect(db.raw.prepare("SELECT status, attempt_count FROM deliveries WHERE id = 'delivery'").get()).toEqual({
      status: "delivered",
      attempt_count: 2,
    });
    expect(db.raw.prepare("SELECT attempt, status FROM delivery_attempts WHERE delivery_id = 'delivery'").all())
      .toEqual([{ attempt: 2, status: "delivered" }]);
  });

  it("dead-letters an expired delivery without calling the driver", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const driver = new ProgrammableDriver(() => ({ status: "delivered" }));
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => now,
    });
    insertAppendDelivery(db, {
      availableAt: now.toISOString(),
      deadlineAt: now.toISOString(),
    });

    await dispatcher.drain();

    expect(driver.requests).toHaveLength(0);
    expect(db.raw.prepare("SELECT status, last_error FROM deliveries WHERE id = 'delivery'").get()).toEqual({
      status: "dead-letter",
      last_error: "Delivery TTL expired",
    });
  });

  it("records a permanent driver failure as a terminal dead-letter", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const driver = new ProgrammableDriver(() => ({
      status: "dead-letter",
      detail: "HTTP 400: invalid append payload",
    }));
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => now,
    });
    insertAppendDelivery(db, {
      availableAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    await dispatcher.drain();

    expect(driver.requests).toHaveLength(1);
    expect(db.raw.prepare(
      "SELECT status, attempt_count, last_error FROM deliveries WHERE id = 'delivery'",
    ).get()).toEqual({
      status: "dead-letter",
      attempt_count: 1,
      last_error: "HTTP 400",
    });
    expect(db.raw.prepare(
      "SELECT attempt, status, detail FROM delivery_attempts WHERE delivery_id = 'delivery'",
    ).get()).toEqual({
      attempt: 1,
      status: "dead-letter",
      detail: "HTTP 400",
    });
  });

  it("classifies untrusted driver diagnostics before persistence and publication", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const sensitive = "Authorization: Bearer private-driver-token";
    const published: unknown[] = [];
    const unsubscribe = events.subscribe((event) => published.push(event));
    const driver = new ProgrammableDriver((attempt) => {
      if (attempt === 1) throw new Error(sensitive);
      return { status: "dead-letter", detail: `HTTP 400: ${sensitive}` };
    });
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => new Date(nowMs),
    });
    insertAppendDelivery(db, {
      availableAt: new Date(nowMs).toISOString(),
      deadlineAt: new Date(nowMs + 60_000).toISOString(),
    });
    try {
      await dispatcher.drain();
      const retry = db.raw.prepare("SELECT available_at FROM deliveries WHERE id = 'delivery'")
        .get() as { available_at: string };
      nowMs = Date.parse(retry.available_at);
      await dispatcher.drain();
      const delivery = db.raw.prepare("SELECT status, last_error FROM deliveries WHERE id = 'delivery'").get();
      const attempts = db.raw.prepare(
        "SELECT status, detail FROM delivery_attempts WHERE delivery_id = 'delivery' ORDER BY attempt",
      ).all();
      expect(JSON.stringify({ delivery, attempts, published })).not.toContain(sensitive);
      expect(delivery).toEqual({ status: "dead-letter", last_error: "HTTP 400" });
      expect(attempts).toEqual([
        { status: "retry", detail: "Driver error details withheld" },
        { status: "dead-letter", detail: "HTTP 400" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("forms fixed-window batches and keeps boundary and incompatible events separate", async () => {
    vi.useFakeTimers();
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(nowMs);
    const service = new StateHubService(db, events);
    registerProducer(db, "append-producer", "append-producer-token");
    const draft = service.createConfigDraft({
      bindings: [appendBinding("primary", "audit.primary"), appendBinding("secondary", "audit.secondary")],
      driverInstances: [{ id: "append-driver", driverType: "virtual", enabled: true, config: {} }],
    });
    service.publishConfig(draft.revision);
    const driver = new ProgrammableDriver(() => ({ status: "delivered" }));
    const dispatcher = new DeliveryDispatcher(db, { get: () => driver }, events, {
      now: () => new Date(nowMs),
    });
    const emit = (input: OccurrenceEventInput): void => {
      service.emitEvent("append-producer", "append-producer-token", input);
    };

    emit({ eventId: "first", type: "audit.primary", value: { sequence: 1 } });
    nowMs += 99;
    vi.setSystemTime(nowMs);
    emit({ eventId: "second", type: "audit.primary", value: { sequence: 2 } });
    await dispatcher.drain();
    expect(driver.requests).toHaveLength(0);

    nowMs += 1;
    vi.setSystemTime(nowMs);
    emit({ eventId: "at-boundary", type: "audit.primary", value: { sequence: 3 } });
    emit({ eventId: "incompatible", type: "audit.secondary", value: { sequence: 4 } });
    await dispatcher.drain();

    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.batch?.map((item) => item.eventId)).toEqual(["first", "second"]);

    nowMs += 100;
    vi.setSystemTime(nowMs);
    await dispatcher.drain();

    expect(driver.requests).toHaveLength(3);
    expect(driver.requests.slice(1).map((request) => request.batch?.map((item) => item.eventId)).sort())
      .toEqual([["at-boundary"], ["incompatible"]]);
    expect(db.raw.prepare(
      "SELECT event_id, status FROM deliveries WHERE action_kind = 'append-only' ORDER BY created_at, event_id",
    ).all()).toEqual([
      { event_id: "first", status: "delivered" },
      { event_id: "second", status: "delivered" },
      { event_id: "at-boundary", status: "delivered" },
      { event_id: "incompatible", status: "delivered" },
    ]);
    const batches = db.raw.prepare(
      "SELECT event_id, batch_id FROM deliveries WHERE action_kind = 'append-only' ORDER BY event_id",
    ).all() as Array<{ event_id: string; batch_id: string }>;
    expect(batches.find((row) => row.event_id === "first")?.batch_id)
      .toBe(batches.find((row) => row.event_id === "second")?.batch_id);
    expect(new Set(batches.map((row) => row.batch_id)).size).toBe(3);
  });
});

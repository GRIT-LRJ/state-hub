import Database from "better-sqlite3";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { measureHistoricalSize } from "../retention.js";
import { CoreAcceptanceHarness } from "./harness.js";

const statefulBinding: Binding = {
  id: "retention-state",
  name: "Retention state",
  enabled: true,
  selector: { producerId: "retention", signalId: "status", scopePattern: "*" },
  conditions: [],
  mapping: { phase: { kind: "pointer", pointer: "/phase" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "retention-state",
    actionKind: "stateful",
    actionName: "render",
  },
};

const appendBinding: Binding = {
  id: "retention-append",
  name: "Retention append",
  enabled: true,
  selector: { producerId: "retention", eventType: "retention.event", scopePattern: "*" },
  conditions: [],
  mapping: { value: { kind: "pointer", pointer: "/value" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "retention-append",
    actionKind: "append-only",
    actionName: "notify",
  },
  batchWindowMs: 120_000,
};

function openDatabase(path: string, readonly = false): Database.Database {
  const database = new Database(path, readonly ? { readonly: true, fileMustExist: true } : undefined);
  database.pragma("busy_timeout = 5000");
  return database;
}

function rowCount(database: Database.Database, table: string, where = "1 = 1"): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
}

describe("Core historical retention maintenance", () => {
  it("preserves command and event dedupe after capacity cleanup and restart", async () => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* consume request body */ }
      requests.push(request.url ?? "");
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const harness = await CoreAcceptanceHarness.start({
      retentionMaxBytes: 1,
      retentionIntervalMs: 120_000,
    });
    try {
      const producer = await harness.admin.createProducer("retention");
      await harness.admin.publishConfig({
        bindings: [{
          ...appendBinding,
          batchWindowMs: 0,
          target: { ...appendBinding.target, driverInstanceId: "retention-http", actionName: "append" },
        }],
        driverInstances: [{
          id: "retention-http",
          driverType: "http",
          enabled: true,
          config: { baseUrl: `http://127.0.0.1:${address.port}/append`, privateTargetOrigin: new URL(`http://127.0.0.1:${address.port}/append`).origin },
        }],
      });
      const event = { eventId: "durable-event-id", type: "retention.event", value: { value: "once" } };
      const first = await producer.emitEvent(event, "durable-command-key");
      expect(first.response.status).toBe(202);
      await harness.waitFor(async () => requests.length === 1
        && (await harness.admin.snapshot()).pendingDeliveries === 0, {
        description: "first append-only HTTP delivery",
      });

      await harness.crash();
      await harness.restart();
      await harness.waitFor(() => {
        const database = openDatabase(harness.paths.database, true);
        try {
          return rowCount(database, "commands") === 0
            && rowCount(database, "occurrence_events") === 0
            && rowCount(database, "deliveries") === 0
            && rowCount(database, "command_dedupe") === 1
            && rowCount(database, "event_dedupe") === 1;
        } finally {
          database.close();
        }
      }, { description: "capacity cleanup of full command, event, and delivery rows" });
      const protectedOverage = harness.stderrOutput.split("\n")
        .filter((line) => line.startsWith('{"type":"state-hub.retention-over-budget"'))
        .map((line) => JSON.parse(line) as { protectedBytesOverBudget: number });
      expect(protectedOverage.some((report) => report.protectedBytesOverBudget > 0)).toBe(true);

      const repeatedCommand = await producer.emitEvent(event, "durable-command-key");
      expect(repeatedCommand.body.commandId).toBe(first.body.commandId);
      expect((await producer.command(repeatedCommand.body.commandId)).status).toBe("applied");
      const conflict = await producer.fetch("/api/v1/producers/retention/events", {
        method: "POST",
        headers: { "idempotency-key": "durable-command-key" },
        body: JSON.stringify({ ...event, value: { value: "changed" } }),
      });
      expect(conflict.status).toBe(409);
      const repeatedEvent = await producer.emitEvent(
        { ...event, value: { value: "changed" } },
        "second-command-key",
      );
      expect(repeatedEvent.response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(requests).toHaveLength(1);
      const database = openDatabase(harness.paths.database, true);
      try {
        expect(rowCount(database, "deliveries")).toBe(0);
      } finally {
        database.close();
      }
    } finally {
      await harness.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it("enforces the age boundary, protects unfinished delivery references, and preserves projection recovery", async () => {
    const harness = await CoreAcceptanceHarness.start({
      retentionMaxAgeMs: 60_000,
      retentionMaxBytes: 10 * 1024 * 1024,
      retentionIntervalMs: 50,
    });
    try {
      const producer = await harness.admin.createProducer("retention");
      await harness.admin.publishConfig({
        bindings: [statefulBinding, appendBinding],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      const claim = await producer.upsertClaim("scope", "status", { value: { phase: "current" } });
      const event = await producer.emitEvent({
        eventId: "protected-event",
        type: "retention.event",
        value: { value: "pending" },
      });

      await harness.waitFor(() => {
        const database = openDatabase(harness.paths.database, true);
        try {
          const deliveredState = rowCount(
            database,
            "deliveries",
            "action_kind = 'stateful' AND status = 'delivered'",
          );
          const pendingAppend = rowCount(
            database,
            "deliveries",
            "action_kind = 'append-only' AND status = 'pending'",
          );
          return deliveredState === 1 && pendingAppend === 1;
        } finally {
          database.close();
        }
      }, { description: "stateful completion and pending append-only batch" });

      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const database = openDatabase(harness.paths.database);
      try {
        database.transaction(() => {
          database.prepare("UPDATE history SET created_at = ?").run(old);
          database.prepare("UPDATE occurrence_events SET accepted_at = ?").run(old);
          database.prepare("UPDATE commands SET accepted_at = ?, completed_at = ?").run(old, old);
          database.prepare(
            `UPDATE deliveries
             SET created_at = ?, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE ? END`,
          ).run(old, old);
          database.prepare("UPDATE delivery_attempts SET started_at = ?, completed_at = ?").run(old, old);
        })();
      } finally {
        database.close();
      }

      await harness.waitFor(() => {
        const retained = openDatabase(harness.paths.database, true);
        try {
          const onlyPendingDelivery = rowCount(retained, "deliveries") === 1 && rowCount(
            retained,
            "deliveries",
            "action_kind = 'append-only' AND status = 'pending'",
          ) === 1;
          return onlyPendingDelivery && rowCount(retained, "history") === 0
            && rowCount(retained, "delivery_attempts") === 0
            && rowCount(retained, "occurrence_events") === 1
            && rowCount(retained, "commands") === 1;
        } finally {
          retained.close();
        }
      }, { description: "periodic age retention pass" });

      expect((await producer.command(event.body.commandId)).status).toBe("applied");
      const snapshot = await harness.admin.snapshot();
      expect(snapshot.claims).toContainEqual(expect.objectContaining({
        scopeId: "scope",
        signalId: "status",
        value: { phase: "current" },
      }));
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceChannel: "retention-state",
        action: { name: "render", params: { phase: "current" } },
      }));

      await harness.crash();
      await harness.restart();
      await harness.waitFor(() => {
        const recovered = openDatabase(harness.paths.database, true);
        try {
          return rowCount(
            recovered,
            "deliveries",
            "action_kind = 'stateful' AND status = 'delivered'",
          ) === 1;
        } finally {
          recovered.close();
        }
      }, { description: "current projection recovery after retained history was removed" });
      expect((await harness.admin.snapshot()).projections).toContainEqual(expect.objectContaining({
        resourceChannel: "retention-state",
        action: { name: "render", params: { phase: "current" } },
      }));
      expect(claim.response.status).toBe(202);
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("enforces a small cross-table capacity budget by oldest-first periodic cleanup", async () => {
    const maxBytes = 4_000;
    const harness = await CoreAcceptanceHarness.start({
      retentionMaxAgeMs: 24 * 60 * 60 * 1000,
      retentionMaxBytes: maxBytes,
      retentionIntervalMs: 50,
    });
    try {
      const producer = await harness.admin.createProducer("retention");
      await harness.admin.publishConfig({
        bindings: [statefulBinding],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      await producer.upsertClaim("scope", "status", { value: { phase: "capacity-current" } });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);

      const base = Date.now() - 20 * 60 * 1000;
      const at = (offset: number): string => new Date(base + offset * 60_000).toISOString();
      const database = openDatabase(harness.paths.database);
      try {
        database.transaction(() => {
          database.prepare(
            "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES ('capacity-old-history', NULL, ?, ?)",
          ).run(JSON.stringify({ payload: "h".repeat(1_400) }), at(0));
          database.prepare(
            `INSERT INTO commands(
               id, producer_id, kind, status, accepted_at, completed_at, error_message
             ) VALUES ('capacity-old-command', 'retention', 'event.emit', 'applied', ?, ?, ?)`,
          ).run(at(1), at(1), "c".repeat(1_400));
          database.prepare(
            `INSERT INTO occurrence_events(
               producer_id, event_id, type, scope_id, value_json, urgency, revision, accepted_at
             ) VALUES ('retention', 'capacity-old-event', 'retention.event', 'scope', ?, 'ambient', 1, ?)`,
          ).run(JSON.stringify({ payload: "e".repeat(1_400) }), at(2));
          database.prepare(
            `INSERT INTO deliveries(
               id, driver_instance_id, resource_channel, action_kind, action_json, status,
               attempt_count, available_at, created_at, completed_at
             ) VALUES ('capacity-old-delivery', 'virtual-main', 'capacity', 'append-only', ?,
                       'delivered', 1, ?, ?, ?)`,
          ).run(JSON.stringify({ name: "append", params: { payload: "d".repeat(1_400) } }), at(3), at(3), at(3));
          database.prepare(
            `INSERT INTO delivery_attempts(
               delivery_id, attempt, started_at, completed_at, status, detail
             ) VALUES ('capacity-old-delivery', 1, ?, ?, 'delivered', ?)`,
          ).run(at(3), at(3), "a".repeat(1_400));
          database.prepare(
            "INSERT INTO history(kind, subject_id, payload_json, created_at) VALUES ('capacity-newest', NULL, ?, ?)",
          ).run(JSON.stringify({ payload: "n".repeat(900) }), at(19));
        })();
      } finally {
        database.close();
      }

      await harness.waitFor(() => {
        const retained = openDatabase(harness.paths.database, true);
        try {
          const oldRows = rowCount(retained, "history", "kind = 'capacity-old-history'")
            + rowCount(retained, "commands", "id = 'capacity-old-command'")
            + rowCount(retained, "occurrence_events", "event_id = 'capacity-old-event'")
            + rowCount(retained, "deliveries", "id = 'capacity-old-delivery'");
          const size = measureHistoricalSize(retained).total;
          return oldRows === 0
            && rowCount(retained, "history", "kind = 'capacity-newest'") === 1
            && size <= maxBytes;
        } finally {
          retained.close();
        }
      }, { description: "periodic cross-table capacity retention pass" });

      const snapshot = await harness.admin.snapshot();
      expect(snapshot.claims).toContainEqual(expect.objectContaining({ value: { phase: "capacity-current" } }));
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceChannel: "retention-state",
        action: { name: "render", params: { phase: "capacity-current" } },
      }));
      const retained = openDatabase(harness.paths.database, true);
      try {
        expect(rowCount(retained, "delivery_attempts", "delivery_id = 'capacity-old-delivery'")).toBe(0);
        expect(retained.pragma("foreign_key_check")).toEqual([]);
      } finally {
        retained.close();
      }
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("reports protected over-budget recovery data during periodic maintenance and startup", async () => {
    const harness = await CoreAcceptanceHarness.start({
      retentionMaxBytes: 1,
      retentionIntervalMs: 50,
    });
    try {
      const producer = await harness.admin.createProducer("retention");
      await harness.admin.publishConfig({
        bindings: [appendBinding],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      const emitted = await producer.emitEvent({
        eventId: "protected-over-budget",
        type: "retention.event",
        value: { value: "private-recovery-payload" },
      });
      const findReport = () => harness.stderrOutput.split("\n")
        .filter((line) => line.startsWith('{"type":'))
        .map((line) => JSON.parse(line) as { type?: string; protectedBytesOverBudget?: number })
        .find((line) => line.type === "state-hub.retention-over-budget");
      const periodic = await harness.waitFor(() => findReport() || false, {
        description: "periodic protected-data over-budget report",
      });
      expect(periodic.protectedBytesOverBudget).toBeGreaterThan(0);
      expect(harness.stderrOutput).not.toContain("private-recovery-payload");
      expect((await producer.command(emitted.body.commandId)).status).toBe("applied");

      await harness.crash();
      await harness.restart();
      const startup = await harness.waitFor(() => findReport() || false, {
        description: "startup protected-data over-budget report",
      });
      expect(startup.protectedBytesOverBudget).toBeGreaterThan(0);
      expect(harness.stderrOutput).not.toContain("private-recovery-payload");
      expect((await producer.command(emitted.body.commandId)).status).toBe("applied");
      const database = openDatabase(harness.paths.database, true);
      try {
        expect(rowCount(database, "deliveries", "event_id = 'protected-over-budget' AND status = 'pending'"))
          .toBe(1);
        expect(rowCount(database, "occurrence_events", "event_id = 'protected-over-budget'"))
          .toBe(1);
      } finally {
        database.close();
      }
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});

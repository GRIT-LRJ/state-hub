import Database from "better-sqlite3";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const statefulBinding: Binding = {
  id: "transaction-status",
  name: "Transaction status",
  enabled: true,
  selector: { producerId: "transactions", signalId: "status", scopePattern: "*" },
  conditions: [],
  mapping: { phase: { kind: "pointer", pointer: "/phase" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "transaction-light",
    actionKind: "stateful",
    actionName: "render",
  },
};

const eventBinding: Binding = {
  id: "transaction-events",
  name: "Transaction events",
  enabled: true,
  selector: { producerId: "transactions", eventType: "tool.failed", scopePattern: "*" },
  conditions: [],
  mapping: { tool: { kind: "pointer", pointer: "/tool" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "transaction-events",
    actionKind: "append-only",
    actionName: "notify",
  },
};

async function withHarness(work: (harness: CoreAcceptanceHarness) => Promise<void>): Promise<void> {
  const harness = await CoreAcceptanceHarness.start();
  try {
    await work(harness);
  } finally {
    await harness.dispose();
  }
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

function installHistoryFailure(databasePath: string): () => void {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TRIGGER acceptance_fail_command_history
    BEFORE INSERT ON history
    BEGIN
      SELECT RAISE(ABORT, 'acceptance injected history failure');
    END
  `);
  database.close();
  return () => {
    const cleanup = new Database(databasePath);
    cleanup.exec("DROP TRIGGER acceptance_fail_command_history");
    cleanup.close();
  };
}

async function failAtHistory(
  harness: CoreAcceptanceHarness,
  request: () => Promise<Response>,
): Promise<void> {
  const before = await harness.admin.snapshot();
  const removeFailure = installHistoryFailure(harness.paths.database);
  try {
    await expectError(await request(), 500, "INTERNAL_ERROR");
  } finally {
    removeFailure();
  }
  expect(await harness.admin.snapshot()).toEqual(before);
}

function idempotencyHeader(key: string): HeadersInit {
  return { "idempotency-key": key };
}

async function settledSnapshot(harness: CoreAcceptanceHarness) {
  return await harness.waitFor(async () => {
    const snapshot = await harness.admin.snapshot();
    return snapshot.pendingDeliveries === 0 ? snapshot : false;
  }, { description: "transaction acceptance deliveries to settle" });
}

describe("producer command transaction boundary", () => {
  it("commits and deduplicates all four command kinds durably and rejects cross-request key reuse", async () => {
    await withHarness(async (harness) => {
      const producer = await harness.admin.createProducer("transactions");

      const claimInput = { value: { phase: "working" }, urgency: "ambient" as const };
      const upsert = await producer.upsertClaim("scope-a", "status", claimInput, "upsert-key");
      const repeatedUpsert = await producer.upsertClaim("scope-a", "status", claimInput, "upsert-key");
      expect(repeatedUpsert.body.commandId).toBe(upsert.body.commandId);
      await expectError(
        await producer.fetch("/api/v1/producers/transactions/scopes/scope-b/claims/status", {
          method: "PUT",
          headers: idempotencyHeader("upsert-key"),
          body: JSON.stringify(claimInput),
        }),
        409,
        "IDEMPOTENCY_CONFLICT",
      );

      const clear = await producer.clearClaim("scope-a", "status", "clear-key");
      const repeatedClear = await producer.clearClaim("scope-a", "status", "clear-key");
      expect(repeatedClear.body.commandId).toBe(clear.body.commandId);
      await expectError(
        await producer.fetch("/api/v1/producers/transactions/scopes/scope-b/claims/status:clear", {
          method: "POST",
          headers: idempotencyHeader("clear-key"),
        }),
        409,
        "IDEMPOTENCY_CONFLICT",
      );

      const eventInput = { eventId: "event-1", type: "tool.failed", value: { tool: "shell" } };
      const event = await producer.emitEvent(eventInput, "event-key");
      const repeatedEvent = await producer.emitEvent(eventInput, "event-key");
      expect(repeatedEvent.body.commandId).toBe(event.body.commandId);
      await expectError(
        await producer.fetch("/api/v1/producers/transactions/events", {
          method: "POST",
          headers: idempotencyHeader("event-key"),
          body: JSON.stringify({ ...eventInput, value: { tool: "browser" } }),
        }),
        409,
        "IDEMPOTENCY_CONFLICT",
      );

      const snapshotInput = [{ scopeId: "scope-snapshot", signalId: "status", value: { phase: "completed" } }];
      const snapshot = await producer.replaceSnapshot(snapshotInput, "snapshot-key");
      const repeatedSnapshot = await producer.replaceSnapshot(snapshotInput, "snapshot-key");
      expect(repeatedSnapshot.body.commandId).toBe(snapshot.body.commandId);
      await expectError(
        await producer.fetch("/api/v1/producers/transactions/snapshot", {
          method: "PUT",
          headers: idempotencyHeader("snapshot-key"),
          body: JSON.stringify({
            claims: [{ scopeId: "scope-snapshot", signalId: "status", value: { phase: "decision" } }],
          }),
        }),
        409,
        "IDEMPOTENCY_CONFLICT",
      );

      for (const accepted of [upsert, clear, event, snapshot]) {
        expect(accepted.response.status).toBe(202);
        expect((await producer.command(accepted.body.commandId)).status).toBe("applied");
      }

      await harness.crash();
      await harness.restart();
      for (const accepted of [upsert, clear, event, snapshot]) {
        expect((await producer.command(accepted.body.commandId)).status).toBe("applied");
      }
      expect((await harness.admin.snapshot()).claims).toContainEqual(expect.objectContaining({
        producerId: "transactions",
        scopeId: "scope-snapshot",
        signalId: "status",
        value: { phase: "completed" },
      }));
    });
  }, 30_000);

  it("rolls back command, ledger, projection and outbox together for every command kind", async () => {
    await withHarness(async (harness) => {
      const producer = await harness.admin.createProducer("transactions");
      await harness.admin.publishConfig({
        bindings: [statefulBinding, eventBinding],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      await settledSnapshot(harness);

      await failAtHistory(harness, async () => await producer.fetch(
        "/api/v1/producers/transactions/scopes/rollback-upsert/claims/status",
        {
          method: "PUT",
          headers: idempotencyHeader("rollback-upsert"),
          body: JSON.stringify({ value: { phase: "working" } }),
        },
      ));
      const upsert = await producer.upsertClaim(
        "rollback-upsert",
        "status",
        { value: { phase: "working" } },
        "rollback-upsert",
      );
      await settledSnapshot(harness);

      await failAtHistory(harness, async () => await producer.fetch(
        "/api/v1/producers/transactions/scopes/rollback-upsert/claims/status:clear",
        { method: "POST", headers: idempotencyHeader("rollback-clear") },
      ));
      expect((await harness.admin.snapshot()).claims).toContainEqual(expect.objectContaining({
        scopeId: "rollback-upsert",
        signalId: "status",
        value: { phase: "working" },
      }));
      const clear = await producer.clearClaim("rollback-upsert", "status", "rollback-clear");
      await settledSnapshot(harness);

      const events = await harness.observeEvents();
      await events.waitFor("snapshot");
      const eventInput = { eventId: "rollback-event", type: "tool.failed", value: { tool: "shell" } };
      await failAtHistory(harness, async () => await producer.fetch(
        "/api/v1/producers/transactions/events",
        {
          method: "POST",
          headers: idempotencyHeader("rollback-event"),
          body: JSON.stringify(eventInput),
        },
      ));
      const event = await producer.emitEvent(eventInput, "rollback-event");
      expect((await events.waitFor("virtual.rendered")).data).toMatchObject({
        resourceChannel: "transaction-events",
        action: { name: "notify", params: { tool: "shell" } },
      });
      await settledSnapshot(harness);

      await producer.upsertClaim("snapshot-before", "status", { value: { phase: "before" } });
      await settledSnapshot(harness);
      await failAtHistory(harness, async () => await producer.fetch(
        "/api/v1/producers/transactions/snapshot",
        {
          method: "PUT",
          headers: idempotencyHeader("rollback-snapshot"),
          body: JSON.stringify({
            claims: [{ scopeId: "snapshot-after", signalId: "status", value: { phase: "after" } }],
          }),
        },
      ));
      expect((await harness.admin.snapshot()).claims).toContainEqual(expect.objectContaining({
        scopeId: "snapshot-before",
        value: { phase: "before" },
      }));
      const snapshot = await producer.replaceSnapshot(
        [{ scopeId: "snapshot-after", signalId: "status", value: { phase: "after" } }],
        "rollback-snapshot",
      );
      await settledSnapshot(harness);

      await harness.crash();
      await harness.restart();
      for (const accepted of [upsert, clear, event, snapshot]) {
        expect((await producer.command(accepted.body.commandId)).status).toBe("applied");
      }
      const recovered = await harness.admin.snapshot();
      expect(recovered.pendingDeliveries).toBe(0);
      expect(recovered.claims).toEqual([
        expect.objectContaining({ scopeId: "snapshot-after", signalId: "status", value: { phase: "after" } }),
      ]);
    });
  }, 30_000);

  it("keeps authorization and business validation failures stable and free of partial state", async () => {
    await withHarness(async (harness) => {
      const producer = await harness.admin.createProducer("typed-transactions", "official.codex");
      const before = await harness.admin.snapshot();
      const base = "/api/v1/producers/typed-transactions";
      const unauthorizedRequests: Array<[string, RequestInit]> = [
        [`${base}/scopes/scope/claims/status`, { method: "PUT", body: JSON.stringify({ value: { phase: "working" } }) }],
        [`${base}/scopes/scope/claims/status:clear`, { method: "POST" }],
        [`${base}/events`, { method: "POST", body: JSON.stringify({ eventId: "unauthorized", type: "tool.failed" }) }],
        [`${base}/snapshot`, { method: "PUT", body: JSON.stringify({ claims: [] }) }],
      ];
      for (const [path, init] of unauthorizedRequests) {
        const headers = new Headers(init.headers);
        headers.set("authorization", "Bearer wrong-token");
        if (init.body) headers.set("content-type", "application/json");
        await expectError(await harness.fetch(path, { ...init, headers }), 401, "UNAUTHORIZED_PRODUCER");
      }

      await expectError(await producer.fetch(`${base}/scopes/scope/claims/status`, {
        method: "PUT",
        body: JSON.stringify({ value: { phase: "invented" } }),
      }), 422, "SOURCE_SCHEMA_VIOLATION");
      await expectError(await producer.fetch(`${base}/events`, {
        method: "POST",
        body: JSON.stringify({ eventId: "invalid-event", type: "tool.failed", value: { tool: 42 } }),
      }), 422, "SOURCE_SCHEMA_VIOLATION");
      await expectError(await producer.fetch(`${base}/snapshot`, {
        method: "PUT",
        body: JSON.stringify({ claims: [{ scopeId: "scope", signalId: "status", value: { phase: "invented" } }] }),
      }), 422, "SOURCE_SCHEMA_VIOLATION");
      await expectError(await producer.fetch(`${base}/snapshot`, {
        method: "PUT",
        body: JSON.stringify({
          claims: [
            { scopeId: "scope", signalId: "status", value: { phase: "working" } },
            { scopeId: "scope", signalId: "status", value: { phase: "completed" } },
          ],
        }),
      }), 400, "DUPLICATE_SNAPSHOT_CLAIM");
      await expectError(await producer.fetch("/api/v1/producers/typed!transactions/scopes/scope/claims/status:clear", {
        method: "POST",
      }), 400, "INVALID_REQUEST");
      expect(await harness.admin.snapshot()).toEqual(before);
    });
  }, 30_000);

  it("observes a serializable token and SourceDefinition pair during concurrent rotation", async () => {
    await withHarness(async (harness) => {
      const attempts = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
        const producerId = `concurrent-${index}`;
        const oldProducer = await harness.admin.createProducer(producerId, "official.custom-http");
        const write = oldProducer.fetch(
          `/api/v1/producers/${producerId}/scopes/scope/claims/custom`,
          {
            method: "PUT",
            headers: idempotencyHeader(`concurrent-${index}`),
            body: JSON.stringify({ value: { acceptedBy: "custom" } }),
          },
        );
        const replacement = harness.admin.createProducer(producerId, "official.codex");
        const [response, newProducer] = await Promise.all([write, replacement]);
        return { response, newProducer };
      }));

      for (const { response, newProducer } of attempts) {
        expect([202, 401]).toContain(response.status);
        if (response.status === 202) {
          const accepted = await response.json() as { commandId: string };
          expect((await newProducer.command(accepted.commandId)).status).toBe("applied");
        } else {
          expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED_PRODUCER" } });
        }
        await expectError(await newProducer.fetch(
          `/api/v1/producers/${newProducer.producerId}/scopes/scope/claims/status`,
          { method: "PUT", body: JSON.stringify({ value: { phase: "invented" } }) },
        ), 422, "SOURCE_SCHEMA_VIOLATION");
      }
    });
  }, 30_000);

  it("keeps the clear route single-colon and double-colon boundaries deterministic", async () => {
    await withHarness(async (harness) => {
      const producer = await harness.admin.createProducer("transactions");
      await producer.upsertClaim("scope-boundary", "status", { value: { phase: "working" } });
      await producer.upsertClaim("scope-boundary", "status:", { value: { phase: "completed" } });

      await producer.clearClaim("scope-boundary", "status");
      let claims = (await harness.admin.snapshot()).claims;
      expect(claims).toContainEqual(expect.objectContaining({
        scopeId: "scope-boundary",
        signalId: "status:",
        value: { phase: "completed" },
      }));
      expect(claims).not.toContainEqual(expect.objectContaining({
        scopeId: "scope-boundary",
        signalId: "status",
      }));

      await producer.clearClaim("scope-boundary", "status:");
      claims = (await harness.admin.snapshot()).claims;
      expect(claims).not.toContainEqual(expect.objectContaining({
        scopeId: "scope-boundary",
        signalId: "status:",
      }));
    });
  }, 30_000);
});

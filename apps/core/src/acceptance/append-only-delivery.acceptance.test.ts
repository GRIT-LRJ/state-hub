import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { dedupeIdentityHash } from "../dedupe-identity.js";
import { CoreAcceptanceHarness } from "./harness.js";

const diagnosticId = (value: string): string => `sha256:${dedupeIdentityHash(value)}`;

interface BatchItem {
  deliveryId: string;
  producerId?: string;
  eventId?: string;
  eventRevision?: number;
  action: { name: string; params: Record<string, unknown> } | null;
  deadlineAt?: string;
}

interface ProbeRequest {
  deliveryId: string;
  eventId?: string;
  channel: string;
  actionKind: string;
  action: BatchItem["action"];
  batchId?: string;
  batch?: BatchItem[];
  receivedAt: number;
}

class BatchProbe {
  readonly requests: ProbeRequest[] = [];
  readonly #server: Server;
  readonly #responses: Array<{ status: number; body?: string }> = [];
  #holdNext = false;
  #url = "";

  private constructor() {
    this.#server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Omit<ProbeRequest, "receivedAt">;
      this.requests.push({ ...payload, receivedAt: Date.now() });
      if (this.#holdNext) {
        this.#holdNext = false;
        return;
      }
      const { status, body } = this.#responses.shift() ?? { status: 204 };
      response.writeHead(status).end(body ?? (status >= 400 ? "programmed failure" : undefined));
    });
  }

  static async start(): Promise<BatchProbe> {
    const probe = new BatchProbe();
    await new Promise<void>((resolve, reject) => {
      probe.#server.once("error", reject);
      probe.#server.listen(0, "127.0.0.1", () => {
        probe.#server.off("error", reject);
        resolve();
      });
    });
    const address = probe.#server.address() as AddressInfo;
    probe.#url = `http://127.0.0.1:${address.port}/append`;
    return probe;
  }

  get url(): string {
    return this.#url;
  }

  respondWith(...statuses: number[]): void {
    this.#responses.push(...statuses.map((status) => ({ status })));
  }

  respondWithBody(status: number, body: string): void {
    this.#responses.push({ status, body });
  }

  holdNext(): void {
    this.#holdNext = true;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function appendBinding(): Binding {
  return {
    id: "batched-audit",
    name: "Batched audit",
    enabled: true,
    selector: { producerId: "append-acceptance", eventType: "audit.recorded", scopePattern: "*" },
    conditions: [],
    mapping: { sequence: { kind: "pointer", pointer: "/sequence" } },
    target: {
      driverInstanceId: "append-http",
      resourceChannel: "audit",
      actionKind: "append-only",
      actionName: "append",
    },
    batchWindowMs: 500,
  };
}

describe("append-only reliable batching", () => {
  it("does not invoke an exhausted delivery after Core crashes before final-attempt completion", async () => {
    const probe = await BatchProbe.start();
    const harness = await CoreAcceptanceHarness.start({ deliveryLeaseMs: 300 });
    try {
      const producer = await harness.admin.createProducer("append-acceptance");
      await harness.admin.publishConfig({
        bindings: [{ ...appendBinding(), batchWindowMs: 120_000 }],
        driverInstances: [{
          id: "append-http",
          driverType: "http",
          enabled: true,
          config: { baseUrl: probe.url, allowPrivateNetwork: true, timeoutMs: 5_000 },
        }],
      });
      const command = await producer.emitEvent({
        eventId: "final-attempt-crash",
        type: "audit.recorded",
        value: { sequence: 1 },
      });
      expect(command.response.status).toBe(202);
      await harness.crash();
      const database = new Database(harness.paths.database);
      try {
        const updated = database.prepare(
          "UPDATE deliveries SET attempt_count = 7, available_at = ? WHERE event_id = 'final-attempt-crash' AND status = 'pending'",
        ).run(new Date().toISOString());
        expect(updated.changes).toBe(1);
      } finally {
        database.close();
      }

      probe.holdNext();
      await harness.restart();
      await harness.waitFor(() => probe.requests.length === 1, {
        description: "eighth and final HTTP driver invocation",
      });
      const leased = new Database(harness.paths.database, { readonly: true, fileMustExist: true });
      let leaseUntil: string;
      try {
        const row = leased.prepare(
          "SELECT status, attempt_count, lease_until FROM deliveries WHERE event_id = 'final-attempt-crash'",
        ).get() as { status: string; attempt_count: number; lease_until: string };
        expect(row.status).toBe("leased");
        expect(row.attempt_count).toBe(8);
        leaseUntil = row.lease_until;
      } finally {
        leased.close();
      }
      await harness.crash();
      await harness.waitFor(() => Date.now() >= Date.parse(leaseUntil), {
        description: "final attempt lease expiry after Core crash",
      });
      await harness.restart();
      await harness.waitFor(() => {
        const recovered = new Database(harness.paths.database, { readonly: true, fileMustExist: true });
        try {
          const row = recovered.prepare(
            "SELECT status, attempt_count FROM deliveries WHERE event_id = 'final-attempt-crash'",
          ).get() as { status: string; attempt_count: number };
          return row.status === "dead-letter" && row.attempt_count === 8;
        } finally {
          recovered.close();
        }
      }, { description: "dead-letter without a ninth invocation" });
      expect(probe.requests).toHaveLength(1);
    } finally {
      await harness.dispose();
      await probe.close();
    }
  }, 30_000);

  it("keeps untrusted HTTP response contents out of support diagnostics", async () => {
    const probe = await BatchProbe.start();
    const harness = await CoreAcceptanceHarness.start();
    const sensitive = [
      "token=token-value-123",
      "Authorization: Bearer auth-value-456",
      "Cookie: sid=cookie-value-789",
      "credential=credential-value-234",
      "password=password-value-567",
      "secret=secret-value-890",
      "email=person@example.test",
      "phone=+15551234567",
    ];
    try {
      const producer = await harness.admin.createProducer("append-acceptance");
      await harness.admin.publishConfig({
        bindings: [{ ...appendBinding(), batchWindowMs: 0 }],
        driverInstances: [{
          id: "append-http",
          driverType: "http",
          enabled: true,
          config: { baseUrl: probe.url, allowPrivateNetwork: true },
        }],
      });
      for (const [index, value] of sensitive.entries()) {
        probe.respondWithBody(400, value);
        await producer.emitEvent({
          eventId: `sensitive-error-${index}`,
          type: "audit.recorded",
          value: { sequence: index },
        });
        await harness.waitFor(async () => (await harness.admin.snapshot()).deadLetters === index + 1 || false);
      }

      const bundle = await harness.admin.diagnostics();
      const serialized = JSON.stringify(bundle);
      for (const value of sensitive) expect(serialized).not.toContain(value);
      expect(bundle.deliveries).toContainEqual(expect.objectContaining({
        eventId: expect.stringMatching(/^sha256:/u),
        status: "dead-letter",
        attemptCount: 1,
        lastError: "HTTP 400",
      }));
      expect(probe.requests).toHaveLength(sensitive.length);
    } finally {
      await harness.dispose();
      await probe.close();
    }
  }, 30_000);

  it("recovers a persisted window after crash and sends one traceable HTTP batch", async () => {
    const probe = await BatchProbe.start();
    const harness = await CoreAcceptanceHarness.start({ deliveryLeaseMs: 300 });
    try {
      const producer = await harness.admin.createProducer("append-acceptance");
      await harness.admin.publishConfig({
        bindings: [appendBinding()],
        driverInstances: [{
          id: "append-http",
          driverType: "http",
          enabled: true,
          config: { baseUrl: probe.url, allowPrivateNetwork: true },
        }],
      });

      const first = await producer.emitEvent({
        eventId: "audit-1",
        type: "audit.recorded",
        value: { sequence: 1 },
      });
      const second = await producer.emitEvent({
        eventId: "audit-2",
        type: "audit.recorded",
        value: { sequence: 2 },
      });
      expect((await producer.command(first.body.commandId)).status).toBe("applied");
      expect((await producer.command(second.body.commandId)).status).toBe("applied");
      expect((await harness.admin.snapshot()).pendingDeliveries).toBe(2);

      await harness.crash();
      await harness.restart();
      await harness.waitFor(() => probe.requests.length === 1 ? probe.requests[0] : false, {
        description: "recovered append-only batch",
      });
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "batched append-only deliveries to settle" });

      expect(probe.requests).toHaveLength(1);
      expect(probe.requests[0]).toMatchObject({
        channel: "audit",
        actionKind: "append-only",
        batchId: expect.any(String),
      });
      expect(probe.requests[0]?.batch?.map((item) => ({
        producerId: item.producerId,
        eventId: item.eventId,
        eventRevision: item.eventRevision,
        sequence: item.action?.params.sequence,
      }))).toEqual([
        { producerId: "append-acceptance", eventId: "audit-1", eventRevision: expect.any(Number), sequence: 1 },
        { producerId: "append-acceptance", eventId: "audit-2", eventRevision: expect.any(Number), sequence: 2 },
      ]);
      expect((probe.requests[0]?.batch?.[1]?.eventRevision ?? 0))
        .toBeGreaterThan(probe.requests[0]?.batch?.[0]?.eventRevision ?? 0);

      const diagnostics = await harness.admin.diagnostics();
      const deliveries = diagnostics.deliveries as Array<{
        producerId: string;
        eventId: string;
        eventRevision: number;
        batchId: string;
        status: string;
        attemptCount: number;
      }>;
      const audited = deliveries.filter((delivery) =>
        [diagnosticId("audit-1"), diagnosticId("audit-2")].includes(delivery.eventId));
      expect(audited).toHaveLength(2);
      expect(audited.map((delivery) => delivery.producerId))
        .toEqual([diagnosticId("append-acceptance"), diagnosticId("append-acceptance")]);
      expect(audited.map((delivery) => delivery.status)).toEqual(["delivered", "delivered"]);
      expect(new Set(audited.map((delivery) => delivery.batchId)).size).toBe(1);
      expect(audited.map((delivery) => delivery.attemptCount)).toEqual([1, 1]);

      probe.respondWith(503, 503, 204);
      await producer.emitEvent({
        eventId: "audit-retry",
        type: "audit.recorded",
        value: { sequence: 3 },
      });
      await harness.waitFor(() => probe.requests.length === 4 ? true : false, {
        timeoutMs: 5_000,
        description: "append-only exponential retries",
      });
      const retryRequests = probe.requests.slice(1);
      expect(retryRequests[1]!.receivedAt - retryRequests[0]!.receivedAt).toBeGreaterThanOrEqual(200);
      expect(retryRequests[2]!.receivedAt - retryRequests[1]!.receivedAt).toBeGreaterThanOrEqual(450);
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 ? snapshot : false;
      }, { description: "retried append-only delivery to settle" });
      const retryDiagnostics = await harness.admin.diagnostics();
      expect((retryDiagnostics.deliveries as Array<Record<string, unknown>>).find(
        (delivery) => delivery.eventId === diagnosticId("audit-retry"),
      )).toMatchObject({ status: "delivered", attemptCount: 3 });

      probe.respondWith(400);
      await producer.emitEvent({
        eventId: "audit-dead",
        type: "audit.recorded",
        value: { sequence: 4 },
      });
      await harness.waitFor(async () => {
        const snapshot = await harness.admin.snapshot();
        return snapshot.pendingDeliveries === 0 && snapshot.deadLetters === 1 ? snapshot : false;
      }, { description: "permanent append-only failure to dead-letter" });
      expect(probe.requests).toHaveLength(5);
      const deadDiagnostics = await harness.admin.diagnostics();
      expect((deadDiagnostics.deliveries as Array<Record<string, unknown>>).find(
        (delivery) => delivery.eventId === diagnosticId("audit-dead"),
      )).toMatchObject({
        status: "dead-letter",
        attemptCount: 1,
        lastError: expect.stringContaining("HTTP 400"),
      });
    } finally {
      await harness.dispose();
      await probe.close();
    }
  }, 30_000);
});

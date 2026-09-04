import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Binding } from "@state-hub/protocol";
import { registerProducer } from "./auth.js";
import { StateHubDatabase } from "./database.js";
import { DeliveryDispatcher } from "./dispatcher.js";
import { DriverRegistry } from "./drivers.js";
import { HubEventBus } from "./events.js";
import { createServer } from "./server.js";
import { StateHubService } from "./service.js";

const adminToken = "a".repeat(48);
const producerToken = "producer-token-with-enough-randomness";

const statefulBinding: Binding = {
  id: "stateful",
  name: "status",
  enabled: true,
  selector: { producerId: "codex", signalId: "status", scopePattern: "*" },
  conditions: [],
  mapping: { color: { kind: "pointer", pointer: "/color" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "light",
    actionKind: "stateful",
    actionName: "render",
  },
};

const effectBinding: Binding = {
  id: "effect",
  name: "notify",
  enabled: true,
  selector: { producerId: "codex", signalId: "status", scopePattern: "*" },
  conditions: [],
  mapping: { content: { kind: "pointer", pointer: "/phase" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "notifications",
    actionKind: "append-only",
    actionName: "notify",
  },
};

describe("StateHub vertical slice", () => {
  let db: StateHubDatabase;
  let events: HubEventBus;
  let service: StateHubService;
  let drivers: DriverRegistry;
  let dispatcher: DeliveryDispatcher;

  beforeEach(() => {
    db = new StateHubDatabase(":memory:");
    events = new HubEventBus();
    service = new StateHubService(db, events);
    drivers = new DriverRegistry(db, events);
    dispatcher = new DeliveryDispatcher(db, drivers, events);
    registerProducer(db, "codex", producerToken);
    const draft = service.createConfigDraft({
      bindings: [statefulBinding, effectBinding],
      driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
    });
    service.publishConfig(draft.revision);
  });

  afterEach(() => {
    dispatcher.stop();
    drivers.invalidate();
    db.close();
  });

  it("commits command, claim, projection and outbox before acceptance", async () => {
    const accepted = service.upsertClaim("codex", producerToken, "session-1", "status", {
      value: { phase: "decision", color: "#ffaa00" },
      urgency: "action-required",
    });
    expect(service.getCommand("codex", accepted.commandId)?.status).toBe("applied");
    expect(service.snapshot().claims).toHaveLength(1);
    expect(service.snapshot().projections[0]?.action?.params).toEqual({ color: "#ffaa00" });
    expect(service.snapshot().pendingDeliveries).toBe(2);
    await dispatcher.drain();
    expect(service.snapshot().pendingDeliveries).toBe(0);
  });

  it("does not repeat a transition-only claim effect for an identical value", () => {
    const value = { phase: "decision", color: "#ffaa00" };
    service.upsertClaim("codex", producerToken, "session-1", "status", { value });
    service.upsertClaim("codex", producerToken, "session-1", "status", { value });
    const rows = db.raw
      .prepare("SELECT action_kind, count(*) AS count FROM deliveries GROUP BY action_kind ORDER BY action_kind")
      .all() as Array<{ action_kind: string; count: number }>;
    expect(rows.find((row) => row.action_kind === "append-only")?.count).toBe(1);
    expect(rows.find((row) => row.action_kind === "stateful")?.count).toBe(1);
  });

  it("keeps input current while paused and suppresses effects", () => {
    service.setPaused(true);
    service.upsertClaim("codex", producerToken, "session-1", "status", {
      value: { phase: "completed", color: "green" },
    });
    expect(service.snapshot().claims[0]?.value).toEqual({ phase: "completed", color: "green" });
    expect(service.snapshot().projections[0]?.action).toBeNull();
    const effects = db.raw.prepare("SELECT count(*) AS count FROM deliveries WHERE action_kind = 'append-only'").get() as {
      count: number;
    };
    expect(effects.count).toBe(0);
  });

  it("enforces producer authentication and returns 202 after durable work", async () => {
    const app = createServer({ service, events, drivers, adminToken });
    const unauthorized = await app.inject({
      method: "PUT",
      url: "/api/v1/producers/codex/scopes/s1/claims/status",
      payload: { value: { phase: "decision" } },
    });
    expect(unauthorized.statusCode).toBe(401);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/producers/codex/scopes/s1/claims/status",
      headers: { authorization: `Bearer ${producerToken}` },
      payload: { value: { phase: "decision" } },
    });
    expect(response.statusCode).toBe(202);
    expect(service.snapshot().claims).toHaveLength(1);
    await app.close();
  });

  it("arbitrates different Codex session states on one physical output", () => {
    service.upsertClaim("codex", producerToken, "session-working", "status", {
      value: { phase: "working", color: "blue" },
      urgency: "ambient",
    });
    service.upsertClaim("codex", producerToken, "session-decision", "status", {
      value: { phase: "decision", color: "amber" },
      urgency: "action-required",
    });
    expect(service.snapshot().projections[0]?.action?.params).toEqual({ color: "amber" });
    service.clearClaim("codex", producerToken, "session-decision", "status");
    expect(service.snapshot().projections[0]?.action?.params).toEqual({ color: "blue" });
  });

  it("validates values for producers tied to a SourceDefinition", () => {
    registerProducer(db, "typed-codex", "another-secure-producer-token", "official.codex");
    expect(() =>
      service.upsertClaim("typed-codex", "another-secure-producer-token", "session-1", "status", {
        value: { phase: "invented" },
      }),
    ).toThrow(/must be equal to one of the allowed values/u);
    expect(() =>
      service.upsertClaim("typed-codex", "another-secure-producer-token", "session-1", "status", {
        value: { phase: "working" },
      }),
    ).not.toThrow();
  });

  it("exports a support bundle without claim values or credential material", () => {
    service.upsertClaim("codex", producerToken, "session-secret", "status", {
      value: { phase: "working", prompt: "private prompt" },
    });
    const serialized = JSON.stringify(service.diagnosticBundle());
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain(producerToken);
    expect(serialized).toContain("[REDACTED]");
  });
});

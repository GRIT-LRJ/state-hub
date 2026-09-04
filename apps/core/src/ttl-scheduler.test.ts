import { afterEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "@state-hub/protocol";
import { registerProducer } from "./auth.js";
import { StateHubDatabase } from "./database.js";
import { HubEventBus } from "./events.js";
import { StateHubService } from "./service.js";
import { ClaimTtlScheduler } from "./ttl-scheduler.js";

const producerToken = "ttl-producer-token-with-enough-randomness";

function binding(id: string, signalId: string, resourceChannel: string, order = 0): Binding {
  return {
    id,
    name: id,
    enabled: true,
    selector: { producerId: "ttl", signalId, scopePattern: "*" },
    conditions: [],
    mapping: { phase: { kind: "pointer", pointer: "/phase" } },
    target: {
      driverInstanceId: "virtual-main",
      resourceChannel,
      actionKind: "stateful",
      actionName: "render",
    },
    order,
  };
}

describe("ClaimTtlScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("actively applies all stale policies and falls back without another write", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-09-04T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const db = new StateHubDatabase(":memory:");
    const events = new HubEventBus();
    const service = new StateHubService(db, events);
    const scheduler = new ClaimTtlScheduler(service, events);
    const expiredEvents: unknown[] = [];
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "claims.expired") expiredEvents.push(event.data);
    });

    try {
      registerProducer(db, "ttl", producerToken);
      const draft = service.createConfigDraft({
        bindings: [
          binding("fallback", "fallback", "deactivate", -1),
          binding("deactivate", "deactivate", "deactivate"),
          binding("demote", "demote", "demote"),
          binding("retain", "retain", "retain"),
        ],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      service.publishConfig(draft.revision);
      scheduler.start();

      service.upsertClaim("ttl", producerToken, "fallback", "fallback", {
        value: { phase: "fallback" },
        urgency: "ambient",
      });
      const expiresAt = new Date(startedAt.getTime() + 1_000).toISOString();
      service.upsertClaim("ttl", producerToken, "deactivate", "deactivate", {
        value: { phase: "deactivate" },
        urgency: "critical",
        expiresAt,
        stalePolicy: "deactivate",
      });
      service.upsertClaim("ttl", producerToken, "demote", "demote", {
        value: { phase: "demote" },
        urgency: "critical",
        expiresAt,
        stalePolicy: "demote",
      });
      service.upsertClaim("ttl", producerToken, "retain", "retain", {
        value: { phase: "retain" },
        urgency: "critical",
        expiresAt,
        stalePolicy: "retain",
      });

      expect(service.listProjections().find((item) => item.resourceChannel === "deactivate")?.action?.params)
        .toEqual({ phase: "deactivate" });
      const revisionBeforeExpiry = service.snapshot().revision;

      await vi.advanceTimersByTimeAsync(1_000);

      const projections = service.listProjections();
      expect(projections.find((item) => item.resourceChannel === "deactivate")?.action?.params)
        .toEqual({ phase: "fallback" });
      expect(projections.find((item) => item.resourceChannel === "demote")).toMatchObject({
        action: { name: "render", params: { phase: "demote" } },
        urgency: "action-required",
      });
      expect(projections.find((item) => item.resourceChannel === "retain")).toMatchObject({
        action: { name: "render", params: { phase: "retain" } },
        urgency: "critical",
      });
      expect(service.snapshot().revision).toBe(revisionBeforeExpiry + 1);
      expect(expiredEvents).toHaveLength(1);
      expect(service.listPendingClaimExpirations()).toHaveLength(0);
    } finally {
      scheduler.stop();
      unsubscribe();
      db.close();
    }
  });
});

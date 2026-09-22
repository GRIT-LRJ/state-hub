import type { Binding } from "@state-hub/protocol";
import { claimKey } from "@state-hub/domain";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const separator = String.fromCharCode(31);
const firstScope = ["alpha", "beta"].join(separator);
const firstSignal = "gamma";
const secondScope = "alpha";
const secondSignal = ["beta", "gamma"].join(separator);

function binding(id: string, signalId: string | undefined, channel: string, actionKind: Binding["target"]["actionKind"]): Binding {
  return {
    id,
    name: id,
    enabled: true,
    selector: { producerId: "identity", scopePattern: "*", ...(signalId ? { signalId } : {}) },
    conditions: [],
    mapping: { phase: { kind: "pointer", pointer: "/phase" } },
    target: { driverInstanceId: "virtual-main", resourceChannel: channel, actionKind, actionName: "render" },
    honorAcknowledgement: true,
  };
}

const virtualInstance = { id: "virtual-main", driverType: "virtual", enabled: true, config: {} };

describe("ClaimIdentity across real Core APIs", () => {
  it("keeps colliding old keys separate in snapshot validation, contributors and acknowledgements", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("identity");
      await harness.admin.publishConfig({
        bindings: [
          binding("first", firstSignal, "first", "stateful"),
          binding("second", secondSignal, "second", "stateful"),
        ],
        driverInstances: [virtualInstance],
      });
      const result = await producer.replaceSnapshot([
        { scopeId: firstScope, signalId: firstSignal, value: { phase: "same" } },
        { scopeId: secondScope, signalId: secondSignal, value: { phase: "same" } },
      ]);
      expect(result.response.status).toBe(202);
      const initial = await harness.admin.snapshot();
      const first = initial.claims.find((claim) => claim.scopeId === firstScope && claim.signalId === firstSignal);
      const second = initial.claims.find((claim) => claim.scopeId === secondScope && claim.signalId === secondSignal);
      expect(first?.revision).toBe(second?.revision);
      expect(first?.revision).toBeGreaterThan(0);
      const firstProjection = initial.projections.find((projection) => projection.resourceChannel === "first");
      const secondProjection = initial.projections.find((projection) => projection.resourceChannel === "second");
      expect(firstProjection?.action).not.toBeNull();
      expect(secondProjection?.action).not.toBeNull();
      expect(firstProjection?.contributorClaimKeys).toContain(claimKey("identity", firstScope, firstSignal));
      expect(secondProjection?.contributorClaimKeys).toContain(claimKey("identity", secondScope, secondSignal));

      const acknowledgement = await harness.admin.acknowledge("identity", firstScope, firstSignal, first!.revision);
      expect(acknowledgement.status).toBe(204);
      const after = await harness.admin.snapshot();
      expect(after.projections.find((projection) => projection.resourceChannel === "first")?.action).toBeNull();
      expect(after.projections.find((projection) => projection.resourceChannel === "second")?.action).not.toBeNull();
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("accepts encoded separators in HTTP claim parameters and emits both transitions", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("identity");
      await harness.admin.publishConfig({
        bindings: [binding("transition", undefined, "notifications", "queued-effect")],
        driverInstances: [virtualInstance],
      });
      const events = await harness.observeEvents();
      const first = await producer.upsertClaim(firstScope, firstSignal, { value: { phase: "same" } });
      expect(first.response.status).toBe(202);
      await events.waitFor("virtual.rendered");
      const second = await producer.upsertClaim(secondScope, secondSignal, { value: { phase: "same" } });
      expect(second.response.status).toBe(202);
      await events.waitFor("virtual.rendered");
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("does not clear another producer's transition when snapshot producer ID contains an underscore", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const owner = await harness.admin.createProducer("a_b");
      const other = await harness.admin.createProducer("axb");
      await harness.admin.publishConfig({
        bindings: [{ ...binding("shared-transition", undefined, "notifications", "queued-effect"), selector: { scopePattern: "*" } }],
        driverInstances: [virtualInstance],
      });
      const events = await harness.observeEvents();
      expect((await other.upsertClaim("scope", "status", { value: { phase: "same" } })).response.status).toBe(202);
      await events.waitFor("virtual.rendered");
      expect((await owner.replaceSnapshot([])).response.status).toBe(202);
      expect((await other.upsertClaim("scope", "status", { value: { phase: "same" } })).response.status).toBe(202);
      await expect(events.waitFor("virtual.rendered", () => true, { timeoutMs: 600 })).rejects.toThrow(
        "Timed out waiting for SSE event",
      );
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});

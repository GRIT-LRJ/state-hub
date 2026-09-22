import type { Binding } from "@state-hub/protocol";
import { resourceKey } from "@state-hub/domain";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const separator = String.fromCharCode(31);

describe("resource and batch identity integration", () => {
  it("keeps two old-colliding resources as separate projections and driver calls", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("resource-identity");
      const firstInstance = ["virtual", "left"].join(separator);
      const secondInstance = "virtual";
      const firstChannel = "right";
      const secondChannel = ["left", "right"].join(separator);
      const makeBinding = (id: string, signalId: string, driverInstanceId: string, resourceChannel: string): Binding => ({
        id,
        name: id,
        enabled: true,
        selector: { producerId: "resource-identity", signalId, scopePattern: "*" },
        conditions: [],
        mapping: { phase: { kind: "pointer", pointer: "/phase" } },
        target: { driverInstanceId, resourceChannel, actionKind: "stateful", actionName: "render" },
      });
      await harness.admin.publishConfig({
        bindings: [
          makeBinding("first", "first", firstInstance, firstChannel),
          makeBinding("second", "second", secondInstance, secondChannel),
        ],
        driverInstances: [
          { id: firstInstance, driverType: "virtual", enabled: true, config: {} },
          { id: secondInstance, driverType: "virtual", enabled: true, config: {} },
        ],
      });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);
      const events = await harness.observeEvents();
      const result = await producer.replaceSnapshot([
        { scopeId: "scope", signalId: "first", value: { phase: "first" } },
        { scopeId: "scope", signalId: "second", value: { phase: "second" } },
      ]);
      expect(result.response.status).toBe(202);
      const snapshot = await harness.admin.snapshot();
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceKey: resourceKey(firstInstance, firstChannel),
        driverInstanceId: firstInstance,
        resourceChannel: firstChannel,
        action: { name: "render", params: { phase: "first" } },
      }));
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceKey: resourceKey(secondInstance, secondChannel),
        driverInstanceId: secondInstance,
        resourceChannel: secondChannel,
        action: { name: "render", params: { phase: "second" } },
      }));
      const renderOne = await events.waitFor("virtual.rendered");
      const renderTwo = await events.waitFor("virtual.rendered");
      expect(new Set([renderOne, renderTwo].map((event) => {
        const data = event.data as { action?: { params?: { phase?: string } } };
        return data.action?.params?.phase;
      }))).toEqual(new Set(["first", "second"]));
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("does not merge different binding actions whose old batch keys collided", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("batch-identity");
      const firstId = ["a", "b"].join(separator);
      const secondAction = ["b", "c"].join(separator);
      const makeBinding = (id: string, eventType: string, actionName: string): Binding => ({
        id,
        name: id,
        enabled: true,
        selector: { producerId: "batch-identity", eventType, scopePattern: "*" },
        conditions: [],
        mapping: { sequence: { kind: "pointer", pointer: "/sequence" } },
        target: {
          driverInstanceId: "virtual-main",
          resourceChannel: "audit",
          actionKind: "append-only",
          actionName,
        },
        batchWindowMs: 1_000,
      });
      await harness.admin.publishConfig({
        bindings: [makeBinding(firstId, "event.first", "c"), makeBinding("a", "event.second", secondAction)],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      });
      const events = await harness.observeEvents();
      expect((await producer.emitEvent({ eventId: "first", type: "event.first", value: { sequence: 1 } })).response.status)
        .toBe(202);
      expect((await producer.emitEvent({ eventId: "second", type: "event.second", value: { sequence: 2 } })).response.status)
        .toBe(202);
      const first = await events.waitFor("virtual.rendered");
      const second = await events.waitFor("virtual.rendered");
      const names = [first, second].map((event) => (event.data as { action?: { name?: string } }).action?.name);
      expect(new Set(names)).toEqual(new Set(["c", secondAction]));
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});

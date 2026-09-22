import { describe, expect, it } from "vitest";
import { pushPlusConfig, type ActiveConfig } from "./management.js";

const current: ActiveConfig = {
  driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
  bindings: [{ id: "virtual-binding", target: { driverInstanceId: "virtual-main",
    resourceChannel: "status", actionKind: "stateful", actionName: "render" } }],
};

describe("PushPlus desktop draft", () => {
  it("preserves other outputs and stores only a credential reference", () => {
    const next = pushPlusConfig(current, {
      instanceId: "pushplus-main", producerId: "source-a", eventType: "custom",
      contentPointer: "/content", tokenSecretRef: "pushplus:main", topic: "alerts",
    });
    expect(next.driverInstances).toHaveLength(2);
    expect(next.bindings).toHaveLength(2);
    expect(next.driverInstances[0]).toEqual(current.driverInstances[0]);
    expect(next.bindings[0]).toEqual(current.bindings[0]);
    expect(next.driverInstances[1]?.config).toEqual({ tokenSecretRef: "pushplus:main", topic: "alerts" });
    expect(next.bindings[1]).toMatchObject({
      selector: { producerId: "source-a", eventType: "custom" },
      mapping: { content: { kind: "pointer", pointer: "/content" } },
      target: { actionKind: "append-only", actionName: "send" },
    });
  });

  it("does not overwrite an unrelated driver or binding with the same id", () => {
    const setup = { instanceId: "pushplus-main", producerId: "source-a", eventType: "custom",
      contentPointer: "/content", tokenSecretRef: "pushplus:main" };
    expect(() => pushPlusConfig({ ...current, driverInstances: [
      ...current.driverInstances, { id: "pushplus-main", driverType: "http", enabled: true, config: {} },
    ] }, setup)).toThrow("DRIVER_INSTANCE_ID_CONFLICT");
    expect(() => pushPlusConfig({ ...current, bindings: [
      ...current.bindings, { id: "pushplus:pushplus-main", target: { driverInstanceId: "other",
        resourceChannel: "other", actionKind: "stateful", actionName: "render" } },
    ] }, setup)).toThrow("BINDING_ID_CONFLICT");
  });
});

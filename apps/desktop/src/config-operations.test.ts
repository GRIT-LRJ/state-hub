import { describe, expect, it } from "vitest";
import type { Binding } from "@state-hub/protocol";
import type { ConfigInstance, ManagedConfig } from "./config-management.js";
import { applyOperation } from "./config-operations.js";
const output: ConfigInstance = { id: "one", driverType: "virtual", enabled: true, config: {} };
const rule: Binding = { id: "rule", name: "rule", enabled: true, selector: {}, conditions: [], mapping: {},
  target: { driverInstanceId: "one", resourceChannel: "status", actionKind: "stateful", actionName: "render" } };
const base: ManagedConfig = { driverInstances: [output], bindings: [rule] };
describe("single operation merge", () => {
  it("preserves unrelated concurrent edits", () => {
    const latest = { ...base, bindings: [{ ...rule, name: "new name" }] };
    const result = applyOperation(latest, { kind: "output", id: "one", before: output, after: { ...output, enabled: false } });
    expect(result.bindings).toEqual(latest.bindings); expect(result.driverInstances[0]?.enabled).toBe(false);
  });
  it("rejects changed entities, colliding new identifiers, and removed or changed target outputs", () => {
    expect(() => applyOperation(base, { kind: "output", id: "one", before: undefined, after: output })).toThrow("EDIT_CONFLICT");
    expect(() => applyOperation({ ...base, driverInstances: [{ ...output, enabled: false }] },
      { kind: "output", id: "one", before: output, after: output })).toThrow("EDIT_CONFLICT");
    expect(() => applyOperation({ ...base, driverInstances: [] },
      { kind: "rule", id: rule.id, before: rule, after: rule, dependency: output })).toThrow("OUTPUT_CHANGED");
  });
  it("blocks output removal while referenced, but permits independent rule removal", () => {
    expect(() => applyOperation(base, { kind: "output", id: "one", before: output, after: undefined })).toThrow("OUTPUT_IN_USE");
    const result = applyOperation(base, { kind: "rule", id: rule.id, before: rule, after: undefined, dependency: undefined });
    expect(result).toEqual({ driverInstances: [output], bindings: [] });
  });
});

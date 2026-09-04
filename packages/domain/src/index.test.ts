import { describe, expect, it } from "vitest";
import type { ActionCandidate, Binding, StateClaim } from "@state-hub/protocol";
import {
  arbitrate,
  bindingMatchesClaim,
  buildAction,
  candidateFromClaim,
  effectiveClaim,
  stableStringify,
} from "./index.js";

const binding: Binding = {
  id: "binding-1",
  name: "decision light",
  enabled: true,
  selector: { producerId: "codex", scopePattern: "session-*", signalId: "status" },
  conditions: [{ pointer: "/phase", operator: "eq", value: "decision" }],
  mapping: {
    color: { kind: "pointer", pointer: "/color" },
    label: { kind: "template", template: "phase={{/phase}}" },
  },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "status",
    actionKind: "stateful",
    actionName: "render",
  },
  order: 10,
};

const claim: StateClaim = {
  producerId: "codex",
  scopeId: "session-a",
  signalId: "status",
  revision: 7,
  value: { phase: "decision", color: "#ffaa00" },
  urgency: "action-required",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("binding", () => {
  it("matches structured selectors and maps without executing code", () => {
    expect(bindingMatchesClaim(binding, claim)).toBe(true);
    expect(buildAction(binding, claim.value)).toEqual({
      name: "render",
      params: { color: "#ffaa00", label: "phase=decision" },
    });
  });

  it("deactivates expired claims by default and can demote", () => {
    expect(
      effectiveClaim({ ...claim, expiresAt: "2025-01-01T00:00:00.000Z" }, new Date("2026-01-01")),
    ).toEqual({ active: false, urgency: "action-required" });
    expect(
      effectiveClaim(
        { ...claim, stalePolicy: "demote", expiresAt: "2025-01-01T00:00:00.000Z" },
        new Date("2026-01-01"),
      ),
    ).toEqual({ active: true, urgency: "informational" });
  });
});

describe("arbitration", () => {
  const candidate = (overrides: Partial<ActionCandidate>): ActionCandidate => ({
    bindingId: "b",
    serverRevision: 1,
    urgency: "ambient",
    bindingOrder: 0,
    driverInstanceId: "virtual-main",
    resourceChannel: "status",
    actionKind: "stateful",
    action: { name: "render", params: { color: "blue" } },
    active: true,
    ...overrides,
  });

  it("uses urgency, order, then latest revision and coalesces identical actions", () => {
    const result = arbitrate(
      [
        candidate({ bindingId: "low", urgency: "ambient", serverRevision: 99 }),
        candidate({ bindingId: "high-a", urgency: "critical", bindingOrder: 1, claimKey: "a" }),
        candidate({ bindingId: "high-b", urgency: "critical", bindingOrder: 2, claimKey: "b" }),
      ],
      100,
    );
    expect(result[0]?.urgency).toBe("critical");
    expect(result[0]?.contributorBindingIds).toEqual(["high-b", "high-a", "low"]);
  });

  it("uses the latest claim revision when urgency and binding order tie", () => {
    const result = arbitrate(
      [
        candidate({
          bindingId: "z-older",
          claimRevision: 10,
          serverRevision: 50,
          action: { name: "render", params: { phase: "older" } },
        }),
        candidate({
          bindingId: "a-newer",
          claimRevision: 11,
          serverRevision: 50,
          action: { name: "render", params: { phase: "newer" } },
        }),
      ],
      51,
    );
    expect(result[0]?.action?.params).toEqual({ phase: "newer" });
  });

  it("honors acknowledgements only when the binding requests it", () => {
    const result = arbitrate(
      [candidate({ bindingId: "acked", urgency: "critical", acknowledged: true, honorAcknowledgement: true })],
      2,
    );
    expect(result[0]?.action).toBeNull();
  });
});

it("stableStringify canonicalizes object keys", () => {
  expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
});

it("creates candidates from current claims", () => {
  expect(candidateFromClaim(binding, claim, 12, false)?.action.name).toBe("render");
});

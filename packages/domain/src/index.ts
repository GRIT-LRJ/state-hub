import type {
  ActionCandidate,
  ActionPayload,
  Binding,
  BindingCondition,
  MappingExpression,
  OccurrenceEvent,
  Projection,
  StateClaim,
  Urgency,
} from "@state-hub/protocol";

const urgencyRank: Record<Urgency, number> = {
  ambient: 0,
  informational: 1,
  "action-required": 2,
  critical: 3,
};

export function claimKey(producerId: string, scopeId: string, signalId: string): string {
  return `${producerId}\u001f${scopeId}\u001f${signalId}`;
}

export function resourceKey(driverInstanceId: string, resourceChannel: string): string {
  return `${driverInstanceId}\u001f${resourceChannel}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function readPointer(input: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return input;
  if (!pointer.startsWith("/")) return undefined;
  let current = input;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function globMatches(value: string, pattern = "*"): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function compare(condition: BindingCondition, actual: unknown): boolean {
  switch (condition.operator) {
    case "exists":
      return actual !== undefined;
    case "eq":
      return stableStringify(actual) === stableStringify(condition.value);
    case "neq":
      return stableStringify(actual) !== stableStringify(condition.value);
    case "contains":
      return typeof actual === "string"
        ? actual.includes(String(condition.value ?? ""))
        : Array.isArray(actual) && actual.some((item) => stableStringify(item) === stableStringify(condition.value));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof condition.value !== "number") return false;
      if (condition.operator === "gt") return actual > condition.value;
      if (condition.operator === "gte") return actual >= condition.value;
      if (condition.operator === "lt") return actual < condition.value;
      return actual <= condition.value;
    }
  }
  return false;
}

function evaluateMapping(expression: MappingExpression, input: unknown): unknown {
  if (expression.kind === "constant") return expression.value;
  if (expression.kind === "pointer") return readPointer(input, expression.pointer);
  return expression.template.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match: string, pointer: string) => {
    const value = readPointer(input, pointer.trim());
    return value === undefined || value === null ? "" : typeof value === "string" ? value : stableStringify(value);
  });
}

export function bindingMatchesClaim(binding: Binding, claim: StateClaim): boolean {
  const selector = binding.selector;
  if (!binding.enabled || selector.eventType) return false;
  if (selector.producerId && selector.producerId !== claim.producerId) return false;
  if (selector.sourceType && selector.sourceType !== claim.sourceType) return false;
  if (selector.signalId && selector.signalId !== claim.signalId) return false;
  if (!globMatches(claim.scopeId, selector.scopePattern)) return false;
  return binding.conditions.every((condition) => compare(condition, readPointer(claim.value, condition.pointer)));
}

export function bindingMatchesEvent(binding: Binding, event: OccurrenceEvent): boolean {
  const selector = binding.selector;
  if (!binding.enabled || selector.signalId) return false;
  if (selector.producerId && selector.producerId !== event.producerId) return false;
  if (selector.sourceType && selector.sourceType !== event.sourceType) return false;
  if (selector.eventType && selector.eventType !== event.type) return false;
  if (!globMatches(event.scopeId ?? "default", selector.scopePattern)) return false;
  return binding.conditions.every((condition) => compare(condition, readPointer(event.value, condition.pointer)));
}

export function buildAction(binding: Binding, input: unknown): ActionPayload {
  return {
    name: binding.target.actionName,
    params: Object.fromEntries(
      Object.entries(binding.mapping).map(([key, expression]) => [key, evaluateMapping(expression, input)]),
    ),
  };
}

export function effectiveClaim(
  claim: StateClaim,
  now = new Date(),
): { active: boolean; urgency: Urgency } {
  const urgency = claim.urgency ?? "ambient";
  if (!claim.expiresAt || Date.parse(claim.expiresAt) > now.getTime()) return { active: true, urgency };
  const policy = claim.stalePolicy ?? "deactivate";
  if (policy === "deactivate") return { active: false, urgency };
  if (policy === "retain") return { active: true, urgency };
  const index = Math.max(0, (urgencyRank[urgency] ?? 0) - 1);
  return { active: true, urgency: urgencyLevelsByRank[index] ?? "ambient" };
}

const urgencyLevelsByRank: Urgency[] = ["ambient", "informational", "action-required", "critical"];

export function candidateFromClaim(
  binding: Binding,
  claim: StateClaim,
  serverRevision: number,
  acknowledged: boolean,
  now = new Date(),
): ActionCandidate | null {
  if (!bindingMatchesClaim(binding, claim)) return null;
  const effective = effectiveClaim(claim, now);
  return {
    bindingId: binding.id,
    claimKey: claimKey(claim.producerId, claim.scopeId, claim.signalId),
    claimRevision: claim.revision,
    serverRevision,
    urgency: binding.urgencyOverride ?? effective.urgency,
    bindingOrder: binding.order ?? 0,
    driverInstanceId: binding.target.driverInstanceId,
    resourceChannel: binding.target.resourceChannel,
    actionKind: binding.target.actionKind,
    ...(binding.target.physicalResourceKey ? { physicalResourceKey: binding.target.physicalResourceKey } : {}),
    action: buildAction(binding, claim.value),
    acknowledged,
    honorAcknowledgement: binding.honorAcknowledgement ?? false,
    active: effective.active,
  };
}

export function arbitrate(candidates: readonly ActionCandidate[], projectionRevision: number): Projection[] {
  const groups = new Map<string, ActionCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.actionKind !== "stateful") continue;
    const key = resourceKey(candidate.driverInstanceId, candidate.resourceChannel);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    const eligible = group
      .filter((item) => item.active && !(item.acknowledged && item.honorAcknowledgement))
      .sort(
        (a, b) =>
          (urgencyRank[b.urgency] ?? 0) - (urgencyRank[a.urgency] ?? 0) ||
          b.bindingOrder - a.bindingOrder ||
          b.serverRevision - a.serverRevision ||
          b.bindingId.localeCompare(a.bindingId),
      );
    const winner = eligible[0];
    const sample = group[0];
    if (!sample) throw new Error("arbitration group unexpectedly empty");
    if (!winner) {
      return {
        resourceKey: key,
        driverInstanceId: sample.driverInstanceId,
        resourceChannel: sample.resourceChannel,
        action: null,
        urgency: null,
        contributorBindingIds: [],
        contributorClaimKeys: [],
        revision: projectionRevision,
      };
    }
    const signature = stableStringify(winner.action);
    const contributors = eligible.filter((item) => stableStringify(item.action) === signature);
    return {
      resourceKey: key,
      driverInstanceId: winner.driverInstanceId,
      resourceChannel: winner.resourceChannel,
      action: winner.action,
      urgency: winner.urgency,
      contributorBindingIds: [...new Set(contributors.map((item) => item.bindingId))],
      contributorClaimKeys: [
        ...new Set(contributors.flatMap((item) => (item.claimKey ? [item.claimKey] : []))),
      ],
      revision: projectionRevision,
    };
  });
}

export function actionSignature(action: ActionPayload | null): string {
  return stableStringify(action);
}

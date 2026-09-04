import type { DriverDefinition, SourceDefinition } from "@state-hub/protocol";

export const codexSourceDefinition: SourceDefinition = {
  id: "official.codex",
  version: "1.0.0",
  displayNameKey: "source.codex.name",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      producerId: { type: "string", default: "codex" },
      completedTtlSeconds: { type: "integer", minimum: 1, maximum: 3600, default: 20 },
    },
  },
  claimSchemas: {
    status: {
      type: "object",
      additionalProperties: false,
      required: ["phase"],
      properties: {
        phase: { enum: ["working", "decision", "completed"] },
        turnId: { type: "string" },
        message: { type: "string", maxLength: 2000 },
      },
    },
  },
  eventSchemas: {
    "tool.failed": {
      type: "object",
      additionalProperties: true,
      properties: { tool: { type: "string" }, message: { type: "string" } },
    },
  },
};

export const customSourceDefinition: SourceDefinition = {
  id: "official.custom-http",
  version: "1.0.0",
  displayNameKey: "source.custom.name",
  configSchema: {
    type: "object",
    required: ["producerId"],
    properties: {
      producerId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
      scopeQuota: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      advancedClaimSchema: { type: "object", description: "Optional JSON Schema for source-specific values" },
    },
  },
  claimSchemas: { custom: {} },
  eventSchemas: { custom: {} },
};

export const driverDefinitions: DriverDefinition[] = [
  {
    id: "official.virtual",
    version: "1.0.0",
    displayNameKey: "driver.virtual.name",
    configSchema: { type: "object", additionalProperties: false },
    actions: {
      render: { kind: "stateful", paramsSchema: { type: "object" } },
      notify: { kind: "append-only", paramsSchema: { type: "object" } },
    },
  },
  {
    id: "official.http",
    version: "1.0.0",
    displayNameKey: "driver.http.name",
    configSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl"],
      properties: {
        baseUrl: { type: "string", format: "uri", pattern: "^https?://" },
        method: { enum: ["POST", "PUT"], default: "POST" },
        allowPrivateNetwork: { type: "boolean", default: false },
        timeoutMs: { type: "integer", minimum: 100, maximum: 30000, default: 5000 },
      },
    },
    actions: {
      send: { kind: "queued-effect", paramsSchema: { type: "object" } },
      append: { kind: "append-only", paramsSchema: { type: "object" } },
      project: { kind: "stateful", paramsSchema: { type: "object" } },
    },
  },
  {
    id: "official.pushplus",
    version: "1.0.0",
    displayNameKey: "driver.pushplus.name",
    configSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tokenSecretRef"],
      properties: {
        tokenSecretRef: { type: "string", format: "statehub-secret-ref" },
        topic: { type: "string" },
      },
    },
    actions: {
      send: {
        kind: "append-only",
        paramsSchema: {
          type: "object",
          required: ["content"],
          properties: { title: { type: "string" }, content: { type: "string" } },
        },
      },
    },
  },
  {
    id: "official.vk87",
    version: "1.0.0",
    displayNameKey: "driver.vk87.name",
    configSchema: {
      type: "object",
      additionalProperties: false,
      required: ["profile"],
      properties: {
        profile: {
          type: "object",
          description: "A verified 65-byte protocol profile for VID 374A / PID A270 / usage FFFF:0002",
        },
      },
    },
    actions: {
      completed: { kind: "stateful", paramsSchema: { type: "object", additionalProperties: false } },
      decision: { kind: "stateful", paramsSchema: { type: "object", additionalProperties: false } },
      idle: { kind: "stateful", paramsSchema: { type: "object", additionalProperties: false } },
    },
  },
];

export const builtinCatalog = {
  sourceDefinitions: [codexSourceDefinition, customSourceDefinition],
  driverDefinitions,
};

export interface CodexHookInput {
  sessionId: string;
  turnId?: string;
  kind: "turn.started" | "approval.requested" | "turn.completed" | "session.closed";
  message?: string;
}

export function codexHookToCommand(input: CodexHookInput): {
  operation: "claim" | "clear";
  scopeId: string;
  signalId: "status";
  body?: Record<string, unknown>;
} {
  if (input.kind === "session.closed") return { operation: "clear", scopeId: input.sessionId, signalId: "status" };
  const phase =
    input.kind === "approval.requested" ? "decision" : input.kind === "turn.completed" ? "completed" : "working";
  return {
    operation: "claim",
    scopeId: input.sessionId,
    signalId: "status",
    body: {
      value: { phase, ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.message ? { message: input.message } : {}) },
      urgency: phase === "decision" ? "action-required" : phase === "completed" ? "informational" : "ambient",
      ...(phase === "completed"
        ? { expiresAt: new Date(Date.now() + 20_000).toISOString(), stalePolicy: "deactivate" }
        : {}),
    },
  };
}

export function dshStateToClaim(state: "decision" | "completed" | "none", sessionId: string) {
  if (state === "none") return { operation: "clear" as const, scopeId: sessionId, signalId: "status" as const };
  return {
    operation: "claim" as const,
    scopeId: sessionId,
    signalId: "status" as const,
    body: {
      value: { phase: state },
      urgency: state === "decision" ? "action-required" : "informational",
    },
  };
}

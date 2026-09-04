export const API_VERSION = "v1" as const;
export const PLUGIN_PROTOCOL_VERSION = "1.0" as const;

export const urgencyLevels = [
  "ambient",
  "informational",
  "action-required",
  "critical",
] as const;
export type Urgency = (typeof urgencyLevels)[number];

export type StalePolicy = "deactivate" | "demote" | "retain";
export type ActionKind = "stateful" | "queued-effect" | "append-only";
export type CommandKind = "claim.upsert" | "claim.clear" | "event.emit" | "snapshot.replace";
export type CommandStatus = "accepted" | "applied" | "failed";

export interface StateClaimInput {
  value: unknown;
  urgency?: Urgency;
  expiresAt?: string;
  stalePolicy?: StalePolicy;
  sourceType?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface StateClaim extends StateClaimInput {
  producerId: string;
  scopeId: string;
  signalId: string;
  revision: number;
  updatedAt: string;
}

export interface OccurrenceEventInput {
  eventId: string;
  type: string;
  value?: unknown;
  scopeId?: string;
  urgency?: Urgency;
  occurredAt?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

export interface OccurrenceEvent extends OccurrenceEventInput {
  producerId: string;
  revision: number;
  acceptedAt: string;
}

export type ConditionOperator =
  | "eq"
  | "neq"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists";

export interface BindingCondition {
  pointer: string;
  operator: ConditionOperator;
  value?: unknown;
}

export type MappingExpression =
  | { kind: "constant"; value: unknown }
  | { kind: "pointer"; pointer: string }
  | { kind: "template"; template: string };

export interface BindingSelector {
  producerId?: string;
  sourceType?: string;
  scopePattern?: string;
  signalId?: string;
  eventType?: string;
}

export interface BindingTarget {
  driverInstanceId: string;
  resourceChannel: string;
  actionKind: ActionKind;
  actionName: string;
  physicalResourceKey?: string;
}

export interface Binding {
  id: string;
  name: string;
  enabled: boolean;
  selector: BindingSelector;
  conditions: BindingCondition[];
  mapping: Record<string, MappingExpression>;
  target: BindingTarget;
  urgencyOverride?: Urgency;
  order?: number;
  honorAcknowledgement?: boolean;
  transitionOnly?: boolean;
  batchWindowMs?: number;
}

export interface ActionPayload {
  name: string;
  params: Record<string, unknown>;
}

export interface ActionCandidate {
  bindingId: string;
  claimKey?: string;
  eventId?: string;
  claimRevision?: number;
  serverRevision: number;
  urgency: Urgency;
  bindingOrder: number;
  driverInstanceId: string;
  resourceChannel: string;
  actionKind: ActionKind;
  physicalResourceKey?: string;
  action: ActionPayload;
  acknowledged?: boolean;
  honorAcknowledgement?: boolean;
  active: boolean;
}

export interface Projection {
  resourceKey: string;
  driverInstanceId: string;
  resourceChannel: string;
  action: ActionPayload | null;
  urgency: Urgency | null;
  contributorBindingIds: string[];
  contributorClaimKeys: string[];
  revision: number;
}

export interface AcceptedCommand {
  commandId: string;
  status: "accepted";
  acceptedAt: string;
}

export interface CommandResult {
  commandId: string;
  producerId: string;
  kind: CommandKind;
  status: CommandStatus;
  acceptedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface DriverActionRequest {
  deliveryId: string;
  driverInstanceId: string;
  resourceChannel: string;
  actionKind: ActionKind;
  action: ActionPayload | null;
  projectionRevision?: number;
  deadlineAt?: string;
}

export interface DriverActionResult {
  status: "delivered" | "retry" | "dead-letter" | "suppressed";
  detail?: string;
  retryAfterMs?: number;
}

export interface SourceDefinition {
  id: string;
  version: string;
  displayNameKey: string;
  claimSchemas: Record<string, Record<string, unknown>>;
  eventSchemas: Record<string, Record<string, unknown>>;
  configSchema: Record<string, unknown>;
}

export interface DriverDefinition {
  id: string;
  version: string;
  displayNameKey: string;
  configSchema: Record<string, unknown>;
  actions: Record<string, { kind: ActionKind; paramsSchema: Record<string, unknown> }>;
}

export interface PluginManifest {
  id: string;
  version: string;
  protocolVersion: string;
  publisher: string;
  license: string;
  entrypoints: Record<string, string>;
  sourceDefinitions?: string[];
  driverDefinitions?: string[];
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const claimInputSchema = {
  $id: "statehub://schemas/v1/state-claim-input",
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {},
    urgency: { enum: [...urgencyLevels] },
    expiresAt: { type: "string", format: "date-time" },
    stalePolicy: { enum: ["deactivate", "demote", "retain"] },
    sourceType: { type: "string", minLength: 1, maxLength: 128 },
    observedAt: { type: "string", format: "date-time" },
    metadata: { type: "object" },
  },
} as const;

export const occurrenceInputSchema = {
  $id: "statehub://schemas/v1/occurrence-event-input",
  type: "object",
  additionalProperties: false,
  required: ["eventId", "type"],
  properties: {
    eventId: { type: "string", minLength: 1, maxLength: 200 },
    type: { type: "string", minLength: 1, maxLength: 128 },
    value: {},
    scopeId: { type: "string", minLength: 1, maxLength: 200 },
    urgency: { enum: [...urgencyLevels] },
    occurredAt: { type: "string", format: "date-time" },
    sourceType: { type: "string", minLength: 1, maxLength: 128 },
    metadata: { type: "object" },
  },
} as const;

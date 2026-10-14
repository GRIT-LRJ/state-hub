import { invoke } from "@tauri-apps/api/core";
import { coreFetch, publishConfig } from "./api.js";

export interface ManagedProducer {
  producerId: string;
  sourceDefinitionId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface SourceOption {
  id: string;
  displayNameKey: string;
  eventSchemas: Record<string, unknown>;
}

interface DriverInstance {
  id: string;
  driverType: string;
  enabled: boolean;
  config: Record<string, unknown>;
  physicalResourceKey?: string;
}

interface Binding {
  id: string;
  target: { driverInstanceId: string; resourceChannel: string; actionKind: string; actionName: string };
  [key: string]: unknown;
}

export interface ActiveConfig {
  driverInstances: DriverInstance[];
  bindings: Binding[];
}

export interface PushPlusSetup {
  instanceId: string;
  producerId: string;
  eventType: string;
  contentPointer: string;
  tokenSecretRef: string;
  topic?: string;
}

function requireOk(response: Response, category: string): void {
  if (!response.ok) throw new Error(`${category}: HTTP ${response.status}`);
}

export async function listSources(): Promise<SourceOption[]> {
  const response = await coreFetch("/api/v1/admin/catalog");
  requireOk(response, "SOURCE_CATALOG_FAILED");
  return ((await response.json()) as { sourceDefinitions: SourceOption[] }).sourceDefinitions;
}

export async function listProducers(): Promise<ManagedProducer[]> {
  const response = await coreFetch("/api/v1/admin/producers");
  requireOk(response, "PRODUCER_LIST_FAILED");
  return ((await response.json()) as { producers: ManagedProducer[] }).producers;
}

export async function issueProducerToken(producerId: string, sourceDefinitionId: string, createOnly = false): Promise<string> {
  const response = await coreFetch("/api/v1/admin/producers", {
    method: "POST", body: JSON.stringify({ producerId, sourceDefinitionId, ...(createOnly ? { createOnly: true } : {}) }),
  });
  if (response.status === 409) throw new Error("PRODUCER_EXISTS");
  requireOk(response, "PRODUCER_SAVE_FAILED");
  return ((await response.json()) as { token: string }).token;
}

export async function revokeProducerToken(producerId: string): Promise<void> {
  const response = await coreFetch(
    `/api/v1/admin/producers/${encodeURIComponent(producerId)}/revoke`, { method: "POST" },
  );
  requireOk(response, "PRODUCER_REVOKE_FAILED");
}

export async function saveSecret(reference: string, value: string): Promise<void> {
  await invoke("store_secret", { reference, value });
}

export async function secretExists(reference: string): Promise<boolean> {
  return await invoke<boolean>("secret_status", { reference });
}

export async function removeSecret(reference: string): Promise<void> {
  await invoke("delete_secret", { reference });
}

export function pushPlusConfig(current: ActiveConfig, setup: PushPlusSetup): ActiveConfig {
  const existing = current.driverInstances.find((entry) => entry.id === setup.instanceId);
  if (existing && !["pushplus", "official.pushplus"].includes(existing.driverType)) {
    throw new Error("DRIVER_INSTANCE_ID_CONFLICT");
  }
  const bindingId = `pushplus:${setup.instanceId}`;
  const priorBinding = current.bindings.find((entry) => entry.id === bindingId);
  if (priorBinding && (priorBinding.target.driverInstanceId !== setup.instanceId ||
    priorBinding.target.actionKind !== "append-only" || priorBinding.target.actionName !== "send")) {
    throw new Error("BINDING_ID_CONFLICT");
  }
  const driverInstance: DriverInstance = {
    id: setup.instanceId,
    driverType: "pushplus",
    enabled: true,
    config: {
      tokenSecretRef: setup.tokenSecretRef,
      ...(setup.topic ? { topic: setup.topic } : {}),
    },
  };
  const binding: Binding = {
    id: bindingId,
    name: `PushPlus ${setup.producerId}`,
    enabled: true,
    selector: { producerId: setup.producerId, eventType: setup.eventType, scopePattern: "*" },
    conditions: [],
    mapping: { content: { kind: "pointer", pointer: setup.contentPointer } },
    target: { driverInstanceId: setup.instanceId, resourceChannel: "messages",
      actionKind: "append-only", actionName: "send" },
  };
  return {
    driverInstances: [...current.driverInstances.filter((entry) => entry.id !== setup.instanceId), driverInstance],
    bindings: [...current.bindings.filter((entry) => entry.id !== bindingId), binding],
  };
}

export async function preparePushPlus(setup: PushPlusSetup): Promise<{ revision: number; impact: Record<string, unknown> }> {
  if (!await secretExists(setup.tokenSecretRef)) throw new Error("CREDENTIAL_MISSING");
  const response = await coreFetch("/api/v1/admin/config/export");
  requireOk(response, "CONFIG_READ_FAILED");
  const { config } = await response.json() as { config: ActiveConfig };
  const draft = await coreFetch("/api/v1/admin/config/drafts", {
    method: "POST", body: JSON.stringify(pushPlusConfig(config, setup)),
  });
  requireOk(draft, "PUSHPLUS_PREVIEW_FAILED");
  return await draft.json() as { revision: number; impact: Record<string, unknown> };
}

export { publishConfig };

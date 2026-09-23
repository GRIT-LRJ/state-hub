import { invoke } from "@tauri-apps/api/core";
import type { ManagedConfig } from "./config-management.js";

export interface CoreConnection {
  endpoint: string;
  adminToken: string;
  generation: number;
}

export interface StateClaim {
  producerId: string;
  scopeId: string;
  signalId: string;
  value: unknown;
  urgency?: string;
  revision: number;
  updatedAt: string;
}

export interface Projection {
  resourceKey: string;
  driverInstanceId: string;
  resourceChannel: string;
  action: { name: string; params: Record<string, unknown> } | null;
  urgency: string | null;
  contributorBindingIds: string[];
  revision: number;
}

export interface RuntimeSnapshot {
  revision: number;
  outputsPaused: boolean;
  claims: StateClaim[];
  projections: Projection[];
  pendingDeliveries: number;
  deadLetters: number;
}

export async function getConnection(): Promise<CoreConnection> {
  return await invoke<CoreConnection>("core_connection");
}

export async function coreFetch(path: string, init?: RequestInit, connection?: CoreConnection): Promise<Response> {
  const current = connection ?? await getConnection();
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${current.adminToken}`);
  if (init?.body) headers.set("content-type", "application/json");
  return await fetch(`${current.endpoint}${path}`, { ...init, headers });
}

export async function fetchSnapshot(connection?: CoreConnection, signal?: AbortSignal): Promise<RuntimeSnapshot> {
  const response = await coreFetch("/api/v1/admin/snapshot", signal ? { signal } : {}, connection);
  if (!response.ok) throw new Error(`Core returned HTTP ${response.status}`);
  return (await response.json()) as RuntimeSnapshot;
}

export async function setOutputsPaused(paused: boolean): Promise<void> {
  const response = await coreFetch("/api/v1/admin/outputs/pause", {
    method: "POST",
    body: JSON.stringify({ paused }),
  });
  if (!response.ok) throw new Error(`Core returned HTTP ${response.status}`);
}

export function mergeCodexVirtual(current: ManagedConfig): ManagedConfig {
  const virtual = current.driverInstances.find((entry) => entry.id === "virtual-main");
  if (virtual && !["virtual", "official.virtual"].includes(virtual.driverType)) {
    throw new Error("VIRTUAL_INSTANCE_ID_CONFLICT");
  }
  const existingBinding = current.bindings.find((entry) => entry.id === "codex-status-to-virtual");
  if (existingBinding && (existingBinding.target.driverInstanceId !== "virtual-main" ||
    existingBinding.target.actionName !== "render" || existingBinding.target.actionKind !== "stateful")) {
    throw new Error("CODEX_BINDING_ID_CONFLICT");
  }
  const binding: ManagedConfig["bindings"][number] = {
    id: "codex-status-to-virtual",
    name: "Codex 状态 → 虚拟输出",
    enabled: true,
    selector: { producerId: "codex", scopePattern: "*", signalId: "status" },
    conditions: [],
    mapping: {
      phase: { kind: "pointer", pointer: "/phase" },
      turnId: { kind: "pointer", pointer: "/turnId" },
    },
    target: { driverInstanceId: "virtual-main", resourceChannel: "codex-status",
      actionKind: "stateful", actionName: "render" },
    honorAcknowledgement: true,
  };
  return {
    driverInstances: virtual ? current.driverInstances.map((entry) =>
      entry.id === virtual.id ? { ...entry, enabled: true } : entry) :
      [...current.driverInstances, { id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
    bindings: existingBinding ? current.bindings : [...current.bindings, binding],
  };
}

export async function provisionCodexVirtual(): Promise<{ revision: number; impact: Record<string, unknown> }> {
  const exported = await coreFetch("/api/v1/admin/config/export");
  if (!exported.ok) throw new Error(`Configuration export returned HTTP ${exported.status}`);
  const { config: current } = await exported.json() as { config: ManagedConfig };
  const config = mergeCodexVirtual(current);
  await invoke("secret_status", { reference: "producer:codex" });
  const producerResponse = await coreFetch("/api/v1/admin/producers", {
    method: "POST",
    body: JSON.stringify({ producerId: "codex", sourceDefinitionId: "official.codex" }),
  });
  if (!producerResponse.ok) throw new Error(`Producer registration returned HTTP ${producerResponse.status}`);
  const producer = (await producerResponse.json()) as { token: string };
  await invoke("store_secret", { reference: "producer:codex", value: producer.token });
  const response = await coreFetch("/api/v1/admin/config/drafts", { method: "POST", body: JSON.stringify(config) });
  if (!response.ok) throw new Error(`Configuration preview returned HTTP ${response.status}`);
  return (await response.json()) as { revision: number; impact: Record<string, unknown> };
}

export async function publishConfig(revision: number): Promise<void> {
  const response = await coreFetch(`/api/v1/admin/config/drafts/${revision}/publish`, { method: "POST", body: "{}" });
  if (!response.ok) throw new Error(`Configuration publish returned HTTP ${response.status}`);
}

export async function subscribe(connection: CoreConnection, onChange: () => void,
  signal: AbortSignal): Promise<void> {
  const response = await coreFetch("/api/v1/admin/events", { signal }, connection);
  if (!response.ok || !response.body) throw new Error(`SSE returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const type = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
        // The initial Core snapshot frame closes the fetch-to-subscribe race; its body is not UI state.
        if (type) onChange();
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > 65_536) throw new Error("SSE_FRAME_TOO_LARGE");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

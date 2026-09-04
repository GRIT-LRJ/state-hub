import { invoke } from "@tauri-apps/api/core";

export interface CoreConnection {
  endpoint: string;
  adminToken: string;
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

let connection: CoreConnection | undefined;

async function getConnection(): Promise<CoreConnection> {
  connection ??= await invoke<CoreConnection>("core_connection");
  return connection;
}

async function coreFetch(path: string, init?: RequestInit): Promise<Response> {
  const current = await getConnection();
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${current.adminToken}`);
  headers.set("content-type", "application/json");
  const response = await fetch(`${current.endpoint}${path}`, { ...init, headers });
  if (response.status === 401) connection = undefined;
  return response;
}

export async function fetchSnapshot(): Promise<RuntimeSnapshot> {
  const response = await coreFetch("/api/v1/admin/snapshot");
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

export async function provisionCodexVirtual(): Promise<{ revision: number; impact: Record<string, unknown> }> {
  const producerResponse = await coreFetch("/api/v1/admin/producers", {
    method: "POST",
    body: JSON.stringify({ producerId: "codex", sourceDefinitionId: "official.codex" }),
  });
  if (!producerResponse.ok) throw new Error(`Producer registration returned HTTP ${producerResponse.status}`);
  const producer = (await producerResponse.json()) as { token: string };
  await invoke("store_secret", { reference: "producer:codex", value: producer.token });
  const config = {
    driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
    bindings: [
      {
        id: "codex-status-to-virtual",
        name: "Codex 状态 → 虚拟输出",
        enabled: true,
        selector: { producerId: "codex", scopePattern: "*", signalId: "status" },
        conditions: [],
        mapping: {
          phase: { kind: "pointer", pointer: "/phase" },
          turnId: { kind: "pointer", pointer: "/turnId" },
        },
        target: {
          driverInstanceId: "virtual-main",
          resourceChannel: "codex-status",
          actionKind: "stateful",
          actionName: "render",
        },
        honorAcknowledgement: true,
      },
    ],
  };
  const response = await coreFetch("/api/v1/admin/config/drafts", { method: "POST", body: JSON.stringify(config) });
  if (!response.ok) throw new Error(`Configuration preview returned HTTP ${response.status}`);
  return (await response.json()) as { revision: number; impact: Record<string, unknown> };
}

export async function publishConfig(revision: number): Promise<void> {
  const response = await coreFetch(`/api/v1/admin/config/drafts/${revision}/publish`, { method: "POST", body: "{}" });
  if (!response.ok) throw new Error(`Configuration publish returned HTTP ${response.status}`);
}

export async function subscribe(onChange: () => void, signal: AbortSignal): Promise<void> {
  const response = await coreFetch("/api/v1/admin/events", { signal });
  if (!response.ok || !response.body) throw new Error(`SSE returned HTTP ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.includes("event: snapshot.changed") || frame.includes("event: outputs.pause-changed")) onChange();
      boundary = buffer.indexOf("\n\n");
    }
  }
}

import type { Binding, DriverDefinition, SourceDefinition } from "@state-hub/protocol";
import { coreFetch, type CoreConnection } from "./api.js";

export interface ConfigInstance {
  id: string;
  driverType: string;
  enabled: boolean;
  config: Record<string, unknown>;
  physicalResourceKey?: string;
}

export interface ManagedConfig {
  driverInstances: ConfigInstance[];
  bindings: Binding[];
}

export interface ConfigCatalog {
  driverDefinitions: DriverDefinition[];
  sourceDefinitions: SourceDefinition[];
}

export interface ConfigRevision {
  revision: number;
  status: "draft" | "published" | "superseded";
  impact: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
}

export interface ConfigPreview {
  revision: number;
  impact: Record<string, unknown>;
  rolledBackFrom?: number;
}

async function jsonOrError<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code: unknown;
    try { code = (await response.json() as { error?: { code?: unknown } }).error?.code; }
    catch { /* unexpected response body */ }
    throw new Error(typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : `HTTP_${response.status}`);
  }
  return await response.json() as T;
}

export async function loadConfigCatalog(connection?: CoreConnection): Promise<ConfigCatalog> {
  return await jsonOrError<ConfigCatalog>(await coreFetch("/api/v1/admin/catalog", undefined, connection));
}

export async function loadManagedConfig(connection?: CoreConnection): Promise<ManagedConfig> {
  const result = await jsonOrError<{ config: ManagedConfig }>(
    await coreFetch("/api/v1/admin/config/export", undefined, connection));
  return result.config;
}

export async function loadConfigRevisions(before?: number, connection?: CoreConnection): Promise<ConfigRevision[]> {
  const params = new URLSearchParams({ limit: "50" });
  if (before !== undefined) params.set("before", String(before));
  const result = await jsonOrError<{ revisions: ConfigRevision[] }>(
    await coreFetch(`/api/v1/admin/config/revisions?${params}`, undefined, connection));
  return result.revisions;
}

export async function previewManagedConfig(config: ManagedConfig, connection?: CoreConnection): Promise<ConfigPreview> {
  return await jsonOrError<ConfigPreview>(await coreFetch("/api/v1/admin/config/drafts", {
    method: "POST", body: JSON.stringify(config),
  }, connection));
}

export async function publishManagedConfig(revision: number, connection?: CoreConnection): Promise<void> {
  await jsonOrError<{ status: string }>(await coreFetch(
    `/api/v1/admin/config/drafts/${revision}/publish`, { method: "POST", body: "{}" }, connection));
}

export async function previewRollback(revision: number, connection?: CoreConnection): Promise<ConfigPreview> {
  return await jsonOrError<ConfigPreview>(await coreFetch(
    `/api/v1/admin/config/revisions/${revision}/rollback`, { method: "POST", body: "{}" }, connection));
}

export function putInstance(config: ManagedConfig, instance: ConfigInstance, originalId?: string): ManagedConfig {
  if (config.driverInstances.some((entry) => entry.id === instance.id && entry.id !== originalId)) {
    throw new Error("DUPLICATE_DRIVER_INSTANCE");
  }
  return { ...config, driverInstances: [
    ...config.driverInstances.filter((entry) => entry.id !== originalId), instance,
  ] };
}

export function putBinding(config: ManagedConfig, binding: Binding, originalId?: string): ManagedConfig {
  if (config.bindings.some((entry) => entry.id === binding.id && entry.id !== originalId)) {
    throw new Error("DUPLICATE_BINDING");
  }
  return { ...config, bindings: [...config.bindings.filter((entry) => entry.id !== originalId), binding] };
}

import { invoke } from "@tauri-apps/api/core";
import { coreFetch, type CoreConnection, type StateClaim } from "./api.js";

export interface DiagnosticPreview {
  files: Array<{ name: string; containsSecrets: boolean }>;
  redaction: string[];
}

export interface DiagnosticDelivery {
  deliveryId: string;
  driverInstanceId: string;
  status: "pending" | "leased" | "delivered" | "dead-letter" | "suppressed";
  actionKind: string;
  attemptCount: number;
  createdAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export function parseDiagnosticDeliveries(text: string): { generatedAt: string; deliveries: DiagnosticDelivery[] } {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (!data || typeof data !== "object" || data.schemaVersion !== 1 || !Array.isArray(data.deliveries) || typeof data.generatedAt !== "string") {
    throw new Error("INVALID_SUPPORT_BUNDLE");
  }
  const deliveries = data.deliveries.slice(0, 500).map((item: Record<string, unknown>) => {
    if (!item || typeof item !== "object" || typeof item.deliveryId !== "string" ||
      typeof item.status !== "string" || !["pending", "leased", "delivered", "dead-letter", "suppressed"].includes(item.status)) {
      throw new Error("INVALID_SUPPORT_BUNDLE");
    }
    return {
      deliveryId: item.deliveryId, driverInstanceId: typeof item.driverInstanceId === "string" ? item.driverInstanceId : "未知",
      status: item.status as DiagnosticDelivery["status"],
      actionKind: typeof item.actionKind === "string" && ["stateful", "queued-effect", "append-only"].includes(item.actionKind) ? item.actionKind : "未知",
      attemptCount: typeof item.attemptCount === "number" && Number.isSafeInteger(item.attemptCount) && item.attemptCount >= 0 ? item.attemptCount : 0,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
      completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
      lastError: typeof item.lastError === "string" && /^(HTTP [1-5]\d{2}|Retry budget exhausted|Delivery TTL expired|Driver error details withheld)$/u.test(item.lastError)
        ? item.lastError : item.lastError ? "Driver error details withheld" : null,
    };
  });
  return { generatedAt: data.generatedAt, deliveries };
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let code: unknown;
  try { code = (await response.json() as { error?: { code?: unknown } }).error?.code; }
  catch { /* Never display a remote body. */ }
  throw new Error(typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? code : `HTTP_${response.status}`);
}

export async function acknowledgeClaim(claim: Pick<StateClaim,
  "producerId" | "scopeId" | "signalId" | "revision">, connection?: CoreConnection): Promise<void> {
  await checked(await coreFetch("/api/v1/admin/acknowledgements", {
    method: "POST",
    body: JSON.stringify({ producerId: claim.producerId, scopeId: claim.scopeId,
      signalId: claim.signalId, claimRevision: claim.revision }),
  }, connection));
}

export async function loadDiagnosticPreview(connection?: CoreConnection): Promise<DiagnosticPreview> {
  return await (await checked(await coreFetch("/api/v1/admin/diagnostics/preview",
    undefined, connection))).json() as DiagnosticPreview;
}

export async function fetchSupportBundle(connection?: CoreConnection): Promise<string> {
  const response = await checked(await coreFetch("/api/v1/admin/diagnostics/export",
    undefined, connection));
  const bundle = await response.json() as { schemaVersion?: unknown };
  if (bundle.schemaVersion !== 1) throw new Error("INVALID_SUPPORT_BUNDLE");
  return JSON.stringify(bundle, null, 2);
}

export async function saveSupportBundle(bundle: string): Promise<boolean> {
  return await invoke<boolean>("save_support_bundle", { bundle });
}

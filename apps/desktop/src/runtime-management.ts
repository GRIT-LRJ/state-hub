import { invoke } from "@tauri-apps/api/core";
import { coreFetch, type CoreConnection, type StateClaim } from "./api.js";

export interface DiagnosticPreview {
  files: Array<{ name: string; containsSecrets: boolean }>;
  redaction: string[];
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

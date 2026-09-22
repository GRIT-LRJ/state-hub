import { createHash, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { PLUGIN_PROTOCOL_VERSION, type PluginManifest } from "@state-hub/protocol";
import { stableStringify } from "@state-hub/domain";
import { unzipSync, zipSync } from "fflate";

export interface PluginChecksums {
  algorithm: "sha256";
  files: Record<string, string>;
}

export interface PluginSignature {
  algorithm: "Ed25519";
  publisher: string;
  signature: string;
}

export interface VerifiedPlugin {
  manifest: PluginManifest;
  files: Map<string, Uint8Array>;
  signed: boolean;
  publisher: string;
}

function walk(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(root, path) : [path];
    })
    .sort((a, b) => a.localeCompare(b));
}

function archivePath(root: string, file: string): string {
  const path = relative(root, file).split(sep).join("/");
  if (!safePath(path)) throw new Error("Unsafe plugin path");
  return path;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function checksumPayload(checksums: PluginChecksums): Buffer {
  return Buffer.from(stableStringify(checksums), "utf8");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.includes(":") && !path.includes("\0") &&
    path.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".." && !/[. ]$/u.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part));
}

function definitionPaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !safePath(entry))) {
    throw new Error("Plugin definition paths are invalid");
  }
  return value;
}

function validatePackage(files: ReadonlyMap<string, Uint8Array>): PluginManifest {
  const bytes = files.get("manifest.json");
  if (!bytes) throw new Error("Plugin manifest.json is required");
  let candidate: unknown;
  try { candidate = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch { throw new Error("Plugin manifest JSON is invalid"); }
  if (!isRecord(candidate) ||
    typeof candidate.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.id) ||
    typeof candidate.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(candidate.version) ||
    typeof candidate.publisher !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.publisher) ||
    typeof candidate.license !== "string" || !candidate.license.trim() ||
    candidate.protocolVersion !== PLUGIN_PROTOCOL_VERSION ||
    !isRecord(candidate.entrypoints) || Object.keys(candidate.entrypoints).length === 0) {
    throw new Error("Plugin manifest is incomplete or invalid");
  }
  for (const [platform, path] of Object.entries(candidate.entrypoints)) {
    if (!["win32", "darwin", "linux"].includes(platform) || typeof path !== "string" ||
      !safePath(path) || !files.has(path)) throw new Error("Plugin platform entrypoint is missing or unsafe");
  }
  if (![...files.keys()].some((path) => basename(path).toUpperCase().startsWith("LICENSE"))) {
    throw new Error("Plugin archive must include a license file");
  }
  for (const path of [...definitionPaths(candidate.sourceDefinitions), ...definitionPaths(candidate.driverDefinitions)]) {
    const data = files.get(path);
    if (!data) throw new Error("Plugin definition file is missing");
    let definition: unknown;
    try { definition = JSON.parse(Buffer.from(data).toString("utf8")) as unknown; }
    catch { throw new Error("Plugin definition JSON is invalid"); }
    if (!isRecord(definition) || typeof definition.id !== "string" ||
      typeof definition.version !== "string" || typeof definition.displayNameKey !== "string" ||
      !isRecord(definition.configSchema)) throw new Error("Plugin definition is invalid");
    if ((candidate.sourceDefinitions as unknown[] | undefined)?.includes(path)) {
      if (!isRecord(definition.claimSchemas) || !isRecord(definition.eventSchemas)) {
        throw new Error("Plugin source definition is invalid");
      }
    } else if (!isRecord(definition.actions)) {
      throw new Error("Plugin driver definition is invalid");
    }
  }
  return candidate as unknown as PluginManifest;
}

export function packPlugin(sourceDirectory: string, privateKeyPem: string): Uint8Array {
  const root = resolve(sourceDirectory);
  const files = new Map<string, Uint8Array>();
  for (const file of walk(root)) {
    const path = archivePath(root, file);
    if (path === "checksums.json" || path === "signature.json") continue;
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error("Plugin package may contain only regular files");
    if (stat.size > 64 * 1024 * 1024) throw new Error(`Plugin file exceeds 64 MB: ${path}`);
    files.set(path, readFileSync(file));
  }
  const manifest = validatePackage(files);
  const checksums: PluginChecksums = {
    algorithm: "sha256",
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => [path, sha256(data)])),
  };
  const signature: PluginSignature = {
    algorithm: "Ed25519",
    publisher: manifest.publisher,
    signature: sign(null, checksumPayload(checksums), privateKeyPem).toString("base64"),
  };
  files.set("checksums.json", Buffer.from(`${stableStringify(checksums)}\n`, "utf8"));
  files.set("signature.json", Buffer.from(`${stableStringify(signature)}\n`, "utf8"));
  const entries = Object.fromEntries(
    [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => [
      path,
      [data, { mtime: new Date("1980-01-01T00:00:00.000Z"), attrs: 0o100644 << 16 }],
    ]),
  ) as Record<string, [Uint8Array, { mtime: Date; attrs: number }]>;
  return zipSync(entries, { level: 9 });
}

export function verifyPlugin(
  archive: Uint8Array,
  trustedPublishers: ReadonlyMap<string, string>,
  options: { developmentMode?: boolean } = {},
): VerifiedPlugin {
  if (archive.byteLength > 128 * 1024 * 1024) throw new Error("Plugin archive exceeds 128 MB");
  let totalSize = 0;
  const seenPaths = new Set<string>();
  const extracted = unzipSync(archive, { filter: (file) => {
    const path = file.name.endsWith("/") ? file.name.slice(0, -1) : file.name;
    if (!safePath(path)) throw new Error("Unsafe plugin archive path");
    const canonicalPath = path.toLowerCase();
    if (seenPaths.has(canonicalPath)) throw new Error("Plugin archive has colliding paths");
    seenPaths.add(canonicalPath);
    if (file.originalSize > 64 * 1024 * 1024) throw new Error("Plugin file exceeds 64 MB");
    totalSize += file.originalSize;
    if (totalSize > 128 * 1024 * 1024) throw new Error("Plugin extracted content exceeds 128 MB");
    return !file.name.endsWith("/");
  } });
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(extracted)) {
    if (!safePath(path)) throw new Error("Unsafe plugin archive path");
    files.set(path, data);
  }
  if (new Set([...files.keys()].map((path) => path.toLowerCase())).size !== files.size) {
    throw new Error("Plugin archive has colliding paths");
  }
  const manifestBytes = files.get("manifest.json");
  const checksumsBytes = files.get("checksums.json");
  if (!manifestBytes || !checksumsBytes) throw new Error("Plugin manifest or checksums are missing");
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as PluginManifest;
  const checksums = JSON.parse(Buffer.from(checksumsBytes).toString("utf8")) as PluginChecksums;
  if (checksums.algorithm !== "sha256") throw new Error("Unsupported checksum algorithm");
  const declaredPaths = Object.keys(checksums.files).sort();
  const contentPaths = [...files.keys()].filter((path) => path !== "checksums.json" && path !== "signature.json").sort();
  if (stableStringify(declaredPaths) !== stableStringify(contentPaths)) throw new Error("Plugin checksum file list mismatch");
  for (const path of declaredPaths) {
    const data = files.get(path);
    if (!data || sha256(data) !== checksums.files[path]) throw new Error(`Plugin checksum mismatch: ${path}`);
  }
  const signatureBytes = files.get("signature.json");
  if (!signatureBytes) {
    if (!options.developmentMode) throw new Error("Unsigned plugins are allowed only in development mode");
    return { manifest: validatePackage(files), files, signed: false, publisher: manifest.publisher };
  }
  const signature = JSON.parse(Buffer.from(signatureBytes).toString("utf8")) as PluginSignature;
  if (signature.algorithm !== "Ed25519" || signature.publisher !== manifest.publisher) {
    throw new Error("Plugin signature metadata mismatch");
  }
  const publicKey = trustedPublishers.get(signature.publisher);
  if (!publicKey) throw new Error(`Publisher is not trusted: ${signature.publisher}`);
  if (!verify(null, checksumPayload(checksums), publicKey, Buffer.from(signature.signature, "base64"))) {
    throw new Error("Plugin signature verification failed");
  }
  return { manifest: validatePackage(files), files, signed: true, publisher: signature.publisher };
}

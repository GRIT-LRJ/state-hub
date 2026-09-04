import { createHash, sign, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { PluginManifest } from "@state-hub/protocol";
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
  if (!path || path.startsWith("../") || path.includes("/../") || path.startsWith("/")) {
    throw new Error(`Unsafe plugin path: ${path}`);
  }
  return path;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function checksumPayload(checksums: PluginChecksums): Buffer {
  return Buffer.from(stableStringify(checksums), "utf8");
}

export function packPlugin(sourceDirectory: string, privateKeyPem: string): Uint8Array {
  const root = resolve(sourceDirectory);
  const files = new Map<string, Uint8Array>();
  for (const file of walk(root)) {
    const path = archivePath(root, file);
    if (path === "checksums.json" || path === "signature.json") continue;
    if (statSync(file).size > 64 * 1024 * 1024) throw new Error(`Plugin file exceeds 64 MB: ${path}`);
    files.set(path, readFileSync(file));
  }
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new Error("Plugin manifest.json is required");
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as PluginManifest;
  if (!manifest.id || !manifest.version || !manifest.publisher || !manifest.license || !manifest.protocolVersion) {
    throw new Error("Plugin manifest is incomplete");
  }
  if (![...files.keys()].some((path) => basename(path).toUpperCase().startsWith("LICENSE"))) {
    throw new Error("Plugin archive must include a license file");
  }
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
  const extracted = unzipSync(archive, { filter: (file) => !file.name.endsWith("/") });
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(extracted)) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`Unsafe plugin archive path: ${path}`);
    }
    files.set(path, data);
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
    return { manifest, files, signed: false, publisher: manifest.publisher };
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
  return { manifest, files, signed: true, publisher: signature.publisher };
}

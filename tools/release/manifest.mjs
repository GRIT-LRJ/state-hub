import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const UPDATE_TARGETS = ["windows-x86_64", "darwin-x86_64", "darwin-aarch64", "linux-x86_64"];

export function releaseManifest(version, entries) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid release version");
  const platforms = {};
  for (const target of UPDATE_TARGETS) {
    const entry = entries[target];
    if (!entry) throw new Error(`Missing update artifact for ${target}`);
    let url;
    try { url = new URL(entry.url); }
    catch { throw new Error(`Invalid update artifact URL for ${target}`); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid update artifact URL for ${target}`);
    }
    if (typeof entry.signature !== "string" || !entry.signature.trim() || entry.signature.includes("\n")) {
      throw new Error(`Invalid update signature for ${target}`);
    }
    platforms[target] = { url: url.toString(), signature: entry.signature.trim() };
  }
  if (Object.keys(entries).length !== UPDATE_TARGETS.length) throw new Error("Unknown update target");
  return { version, platforms };
}

export function manifestFromArtifacts(version, baseUrl, paths) {
  let base;
  try { base = new URL(`${baseUrl.replace(/\/$/, "")}/`); }
  catch { throw new Error("Invalid update artifact base URL"); }
  const entries = {};
  const names = new Set();
  for (const target of UPDATE_TARGETS) {
    const artifact = paths[target];
    if (!artifact || !artifact.file || !artifact.signatureFile) throw new Error(`Missing artifact path for ${target}`);
    if (!statSync(artifact.file).isFile() || artifact.signatureFile !== `${artifact.file}.sig`) {
      throw new Error(`Invalid artifact files for ${target}`);
    }
    const name = basename(artifact.file);
    if (names.has(name)) throw new Error("Updater artifact names must be unique");
    names.add(name);
    const signature = readFileSync(artifact.signatureFile, "utf8");
    entries[target] = {
      url: new URL(encodeURIComponent(name), base).toString(),
      signature,
    };
  }
  return releaseManifest(version, entries);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, baseUrl, descriptorPath, output] = process.argv.slice(2);
  if (!version || !baseUrl || !descriptorPath || !output) throw new Error("Expected version, base URL, descriptor and output");
  const descriptors = JSON.parse(readFileSync(descriptorPath, "utf8"));
  const manifest = manifestFromArtifacts(version, baseUrl, descriptors);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Wrote four-platform updater manifest to ${output}\n`);
}

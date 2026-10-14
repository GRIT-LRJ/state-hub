import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { manifestFromArtifacts } from "./manifest.mjs";

const targets = {
  "windows-x86_64": { directory: "nsis", suffix: "-setup.exe" },
  "darwin-x86_64": { directory: "macos", suffix: ".app.tar.gz" },
  "darwin-aarch64": { directory: "macos", suffix: ".app.tar.gz" },
  "linux-x86_64": { directory: "appimage", suffix: ".AppImage" },
};

export function stableArtifacts(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable artifact version");
  const result = {};
  for (const [target, definition] of Object.entries(targets)) {
    const directory = join(root, `stable-candidate-${target}`, definition.directory);
    const matches = readdirSync(directory)
      .filter((name) => name.endsWith(definition.suffix) &&
        (definition.directory === "macos" || name.includes(version)) &&
        statSync(join(directory, name)).isFile());
    if (matches.length !== 1) throw new Error(`Expected one signed ${target} updater artifact`);
    const file = join(directory, matches[0]);
    const signatureFile = `${file}.sig`;
    if (!existsSync(signatureFile) || !readFileSync(signatureFile, "utf8").trim()) {
      throw new Error(`Missing ${target} updater signature`);
    }
    result[target] = { file, signatureFile };
  }
  const linuxDeb = join(root, "stable-candidate-linux-x86_64", "deb");
  const debs = readdirSync(linuxDeb).filter((name) => name.endsWith(".deb") && name.includes(version));
  if (debs.length !== 1) throw new Error("Expected one stable Linux deb package");
  result.linuxDeb = join(linuxDeb, debs[0]);
  return result;
}

export function stableMetadata(version, artifacts, output) {
  mkdirSync(output, { recursive: true });
  const baseUrl = `https://github.com/GRIT-LRJ/state-hub/releases/download/v${version}`;
  const staged = {};
  for (const [target, definition] of Object.entries(targets)) {
    const file = join(output, `state-hub-v${version}-${target}${definition.suffix}`);
    copyFileSync(artifacts[target].file, file);
    copyFileSync(artifacts[target].signatureFile, `${file}.sig`);
    staged[target] = { file, signatureFile: `${file}.sig` };
  }
  const linuxDeb = join(output, `state-hub-v${version}-linux-x86_64.deb`);
  copyFileSync(artifacts.linuxDeb, linuxDeb);
  const manifest = manifestFromArtifacts(version, baseUrl, staged);
  const files = [...Object.keys(targets).map((target) => staged[target].file), linuxDeb];
  const checksums = files.map((file) =>
    `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}`);
  if (new Set(files.map((file) => basename(file))).size !== files.length) {
    throw new Error("Stable artifact names must be unique");
  }
  return { manifest, checksums: `${checksums.join("\n")}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, version, output] = process.argv.slice(2);
  if (!root || !version || !output) throw new Error("Expected artifact root, version and output directory");
  const artifacts = stableArtifacts(root, version);
  const metadata = stableMetadata(version, artifacts, output);
  writeFileSync(join(output, "latest.json"), `${JSON.stringify(metadata.manifest, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(output, "SHA256SUMS"), metadata.checksums, { flag: "wx" });
  process.stdout.write("Assembled four signed updater entries and five package checksums\n");
}

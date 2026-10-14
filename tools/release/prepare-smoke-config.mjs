import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { updaterConfig } from "./updater-config.mjs";
import { unsignedConfig } from "./unsigned-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(root, ".release-smoke");
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint || !process.env.GITHUB_ENV) {
  throw new Error("Run through pnpm in GitHub Actions");
}
mkdirSync(directory, { recursive: true });
const keyPath = resolve(directory, "ephemeral-updater.key");
execFileSync(process.execPath, [pnpmEntrypoint, "--filter", "@state-hub/desktop", "tauri",
  "signer", "generate", "--ci", "-w", keyPath], { cwd: root, stdio: "ignore" });
const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
const baseConfig = JSON.parse(readFileSync(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const candidateVersion = baseConfig.version;
if (candidateVersion === "0.0.1") throw new Error("Smoke baseline must be older than candidate");
const baseline = resolve(directory, "baseline.json");
const candidate = resolve(directory, "candidate.json");
for (const [file, version] of [[baseline, "0.0.1"], [candidate, candidateVersion]]) {
  const config = updaterConfig({ channel: "beta", publicKey,
    baseUrl: "http://127.0.0.1:39741", localSmoke: true, version });
  const branding = unsignedConfig(baseConfig, "beta");
  config.productName = branding.productName;
  config.identifier = branding.identifier;
  config.app = branding.app;
  if (process.platform === "darwin") config.bundle.macOS = { signingIdentity: "-" };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
}
appendFileSync(process.env.GITHUB_ENV, [
  `STATE_HUB_SMOKE_BASE_CONFIG=${baseline}`,
  `STATE_HUB_SMOKE_CANDIDATE_CONFIG=${candidate}`,
  `TAURI_SIGNING_PRIVATE_KEY=${keyPath}`,
  `TAURI_SIGNING_PRIVATE_KEY_PATH=${keyPath}`,
  "STATE_HUB_SMOKE_BASE_VERSION=0.0.1",
  `STATE_HUB_SMOKE_CANDIDATE_VERSION=${candidateVersion}`,
].join("\n") + "\n");
process.stdout.write("Prepared two signed updater smoke configurations with one ephemeral test key\n");

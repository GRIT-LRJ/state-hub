import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkReleaseCredentials } from "./stable-policy.mjs";
import { updaterConfig } from "./updater-config.mjs";

export function stableConfig(platform, environment) {
  checkReleaseCredentials(platform, environment);
  const config = updaterConfig({ channel: "stable", publicKey: environment.STATE_HUB_UPDATER_PUBLIC_KEY });
  if (platform === "windows") {
    if (!/^[0-9a-f]{40}$/i.test(environment.STATE_HUB_WINDOWS_THUMBPRINT ?? "")) {
      throw new Error("Windows signing certificate thumbprint is missing or invalid");
    }
    let timestamp;
    try { timestamp = new URL(environment.WINDOWS_TIMESTAMP_URL); }
    catch { throw new Error("Windows signing timestamp URL is invalid"); }
    if (!["http:", "https:"].includes(timestamp.protocol) || timestamp.username || timestamp.password) {
      throw new Error("Windows signing timestamp URL is invalid");
    }
    config.bundle.windows = { certificateThumbprint: environment.STATE_HUB_WINDOWS_THUMBPRINT,
      digestAlgorithm: "sha256", timestampUrl: timestamp.toString() };
  }
  if (platform === "darwin") {
    if (!environment.APPLE_SIGNING_IDENTITY?.startsWith("Developer ID Application:")) {
      throw new Error("Developer ID Application signing identity is required");
    }
    config.bundle.macOS = { signingIdentity: environment.APPLE_SIGNING_IDENTITY };
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const platform = process.argv[2];
  const output = process.argv[3];
  if (!output) throw new Error("Stable config output path required");
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(stableConfig(platform, process.env), null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Wrote signed stable build configuration to ${output}\n`);
}

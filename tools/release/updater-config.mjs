import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHANNELS = new Set(["stable", "beta", "alpha"]);
const DEFAULT_BASE = "https://github.com/GRIT-LRJ/state-hub/releases/download";

export function updaterConfig({ channel, publicKey, baseUrl = DEFAULT_BASE, localSmoke = false, version }) {
  if (!CHANNELS.has(channel)) throw new Error("Unknown update channel");
  if (typeof publicKey !== "string" || !publicKey.trim()) throw new Error("Updater public key is required");
  let base;
  try {
    base = new URL(`${baseUrl.replace(/\/$/, "")}/`);
  } catch {
    throw new Error("Invalid update endpoint");
  }
  if (localSmoke ? base.protocol !== "http:" || base.hostname !== "127.0.0.1" : base.protocol !== "https:") {
    throw new Error("Update endpoint must use HTTPS");
  }
  if (base.username || base.password || base.search || base.hash) throw new Error("Invalid update endpoint");
  const endpoint = channel === "stable" && baseUrl === DEFAULT_BASE && !localSmoke
    ? "https://github.com/GRIT-LRJ/state-hub/releases/latest/download/latest.json"
    : new URL(`${channel}/latest.json`, base).toString();
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid updater build version");
  return {
    ...(version ? { version } : {}),
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        active: true,
        pubkey: publicKey.trim(),
        endpoints: [endpoint],
        dialog: false,
        ...(localSmoke ? { dangerousInsecureTransportProtocol: true } : {}),
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output || !(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
    throw new Error("Output path and signing key are required");
  }
  const config = updaterConfig({
    channel: process.env.STATE_HUB_RELEASE_CHANNEL,
    publicKey: process.env.STATE_HUB_UPDATER_PUBLIC_KEY,
    baseUrl: process.env.STATE_HUB_UPDATE_BASE_URL,
    localSmoke: process.env.STATE_HUB_LOCAL_RELEASE_SMOKE === "1",
    version: process.env.STATE_HUB_VERSION_OVERRIDE,
  });
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Wrote updater configuration to ${output}\n`);
}

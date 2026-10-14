import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkStablePolicy(progress, version, appVersion, ancestor = () => true) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version !== appVersion) {
    throw new Error("Stable version must match the desktop package version");
  }
  const rows = new Map();
  for (const line of progress.split(/\r?\n/)) {
    const columns = line.split("|").slice(1, -1).map((part) => part.trim());
    const match = /^#(\d+)\b/.exec(columns[0] ?? "");
    if (match) {
      const number = Number(match[1]);
      if (rows.has(number)) throw new Error(`Duplicate progress entry for Issue #${number}`);
      rows.set(number, { status: columns[1], commits: columns.at(-1) });
    }
  }
  for (let issue = 1; issue <= 23; issue++) {
    const row = rows.get(issue);
    if (!row || row.status !== "PASS") throw new Error(`Issue #${issue} has not passed acceptance`);
    if (issue > 1) {
      const hashes = row.commits?.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
      if (!hashes.length || hashes.some((hash) => !ancestor(hash))) {
        throw new Error(`Issue #${issue} has no verified commit in this candidate`);
      }
    }
  }
}

export function checkReleaseCredentials(platform, environment) {
  const common = ["TAURI_SIGNING_PRIVATE_KEY", "STATE_HUB_UPDATER_PUBLIC_KEY"];
  const platformSecrets = {
    windows: ["WINDOWS_CERTIFICATE_BASE64", "WINDOWS_CERTIFICATE_PASSWORD"],
    darwin: ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"],
    linux: [],
  };
  const required = platformSecrets[platform];
  if (!required) throw new Error("Unsupported stable release platform");
  for (const name of [...common, ...required]) {
    if (typeof environment[name] !== "string" || !environment[name].trim()) {
      throw new Error(`Missing stable release credential: ${name}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = process.argv[2];
  const progress = readFileSync("docs/ISSUE_PROGRESS.md", "utf8");
  const appVersion = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8")).version;
  checkStablePolicy(progress, version, appVersion, (hash) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", hash, "HEAD"], { stdio: "ignore" });
      return true;
    } catch { return false; }
  });
  if (process.argv[3]) checkReleaseCredentials(process.argv[3], process.env);
  process.stdout.write(`Stable product acceptance gate passed for ${version}\n`);
}

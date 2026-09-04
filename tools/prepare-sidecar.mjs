import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("Run this script through pnpm so npm_execpath is available");
const runPnpm = (args) => execFileSync(process.execPath, [pnpmEntrypoint, ...args], { cwd: root, stdio: "inherit" });
const platformName = process.platform === "win32" ? "win" : process.platform === "darwin" ? "macos" : "linux";
const architecture = process.arch === "arm64" ? "arm64" : "x64";
const target = `node24-${platformName}-${architecture}`;
const triples = {
  "win-x64": "x86_64-pc-windows-msvc",
  "win-arm64": "aarch64-pc-windows-msvc",
  "macos-x64": "x86_64-apple-darwin",
  "macos-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
const triple = process.env.STATE_HUB_TARGET_TRIPLE ?? triples[`${platformName}-${architecture}`];
if (!triple) throw new Error(`Unsupported sidecar target: ${platformName}-${architecture}`);

runPnpm(["--filter", "@state-hub/protocol", "build"]);
runPnpm(["--filter", "@state-hub/domain", "build"]);
runPnpm(["--filter", "@state-hub/sdk", "build"]);
runPnpm(["--filter", "@state-hub/core", "build"]);

const extension = process.platform === "win32" ? ".exe" : "";
const temporary = join(root, `state-hub-core${extension}`);
const output = join(root, "apps", "desktop", "src-tauri", "binaries", `state-hub-core-${triple}${extension}`);
const packageCache = join(root, ".pkg-cache");
mkdirSync(dirname(output), { recursive: true });
execFileSync(process.execPath, [pnpmEntrypoint, "exec", "pkg", "apps/core/package.json", "--targets", target, "--output", temporary], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PKG_CACHE_PATH: packageCache },
});
renameSync(temporary, output);
process.stdout.write(`Prepared ${output}\n`);

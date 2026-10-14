import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

const triple = process.platform === "win32" ? "x86_64-pc-windows-msvc"
  : process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64" : "x86_64") + "-apple-darwin"
    : "x86_64-unknown-linux-gnu";
const exe = resolve("apps/desktop/src-tauri/binaries", `state-hub-core-${triple}${process.platform === "win32" ? ".exe" : ""}`);
assert.ok(existsSync(exe), "Built sidecar executable missing");
const root = mkdtempSync(join(tmpdir(), "state-hub-sidecar-smoke-"));
const started = performance.now();
const child = spawn(exe, [], { env: { ...process.env,
  STATE_HUB_ADMIN_TOKEN: randomBytes(32).toString("hex"), STATE_HUB_SUPERVISED: "1",
  STATE_HUB_DATA_DIR: join(root, "data"), STATE_HUB_RUNTIME_DIR: join(root, "runtime") },
  stdio: ["pipe", "ignore", "ignore"] });
const spawnReturnMs = performance.now() - started;
try {
  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const discovery = JSON.parse(readFileSync(join(root, "runtime", "discovery.json"), "utf8"));
      assert.equal(discovery.host, "127.0.0.1");
      const response = await fetch(`http://127.0.0.1:${discovery.port}/health/live`,
        { signal: AbortSignal.timeout(1500) });
      if (response.ok) { healthy = true; break; }
    } catch { /* Waiting for the packaged Core to become ready. */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!healthy) throw new Error("Packaged sidecar did not become healthy");
  process.stdout.write(`Packaged sidecar spawn returned in ${Math.round(spawnReturnMs)}ms; discovery and loopback health in ${Math.round(performance.now() - started)}ms\n`);
} finally {
  child.stdin.end();
  await Promise.race([new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 5000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  const checked = realpathSync(root);
  const tempRoot = realpathSync(tmpdir());
  if (checked.startsWith(`${tempRoot}${sep}`) && checked !== tempRoot) {
    rmSync(checked, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

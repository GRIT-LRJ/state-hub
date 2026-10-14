// Run against a real Tauri executable built with lifecycle-smoke and
// VITE_STATE_HUB_LIFECYCLE_SMOKE=1. It deliberately crashes only its isolated children.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const executable = process.argv[2];
const devOrigin = process.argv[3];
if (!executable) throw new Error("Expected lifecycle-smoke executable path");
const root = mkdtempSync(join(tmpdir(), "state-hub-desktop-lifecycle-"));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const inspectWindowsCore = (pid, terminate = false) => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("INVALID_PROCESS_ID");
  // PIDs were observed being reused even within the five startup attempts.
  // Hold the Process handle across image inspection and optional termination.
  const script = `$entry = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (!$entry) { 'False'; exit }
try {
  $null = $entry.Handle
  if ($entry.HasExited) { 'False' }
  elseif (!$entry.Path) { throw 'PROCESS_IDENTITY_UNAVAILABLE' }
  elseif ($entry.Path -eq $env:STATE_HUB_SMOKE_CORE_IMAGE) { ${terminate ? "$entry.Kill()" : ""}; 'True' }
  else { 'False' }
} finally { $entry.Dispose() }`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 5_000,
    env: { ...process.env, STATE_HUB_SMOKE_CORE_IMAGE: join(dirname(resolve(executable)), "state-hub-core.exe") },
  }).trim() === "True";
};
const coreAlive = (pid) => {
  if (!alive(pid)) return false;
  return process.platform === "win32" ? inspectWindowsCore(pid) : true;
};
const results = [];
process.stdout.write(`Desktop lifecycle evidence: ${root}\n`);
for (const mode of ["recovery", "startup-failure", "parent-crash"]) {
  const directory = join(root, mode);
  mkdirSync(directory);
  const file = join(directory, "evidence.json");
  const env = { ...process.env,
    STATE_HUB_DATA_DIR: join(directory, "data"), STATE_HUB_RUNTIME_DIR: join(directory, "runtime"),
    STATE_HUB_LIFECYCLE_SMOKE_FILE: file, STATE_HUB_LIFECYCLE_SMOKE_MODE: mode,
  };
  // Opening a directory as SQLite deterministically fails before Core can announce ready.
  if (mode === "startup-failure") env.STATE_HUB_DB_PATH = directory;
  else delete env.STATE_HUB_DB_PATH;
  const child = spawn(resolve(executable), [], { env, stdio: "ignore", windowsHide: true });
  let launchError;
  const exited = new Promise((done) => {
    child.once("error", (error) => { launchError = error; done(); });
    child.once("exit", done);
  });
  const started = Date.now();
  let evidence;
  let killedParent = false;
  try {
    while (child.exitCode === null && child.signalCode === null && !launchError && Date.now() - started < 135_000) {
      try { evidence = JSON.parse(readFileSync(file, "utf8")); } catch { /* Atomic observation may race a write. */ }
      if (mode === "parent-crash" && evidence?.connected.length === 1 && !killedParent) {
        killedParent = true;
        child.kill();
      }
      await delay(50);
    }
    if (launchError) throw launchError;
    assert.ok(child.exitCode !== null || child.signalCode !== null, `${mode}: desktop exit timed out`);
    await exited;
    evidence = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(evidence.development, Boolean(devOrigin), "Must test the requested resource mode");
    assert.ok(evidence.origins.length > 0, "Real UI must report its origin");
    assert.ok(evidence.origins.every((origin) => devOrigin ? origin === devOrigin :
      ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"].includes(origin)));
    assert.ok(evidence.spawned.every(([generation, pid]) => Number.isInteger(generation) && Number.isInteger(pid) && pid > 0));
    if (mode === "parent-crash") {
      assert.ok(killedParent);
      assert.equal(evidence.connected.length, 1);
      assert.equal(evidence.spawned.length, 1);
    } else {
      assert.equal(child.exitCode, 0, `${mode}: app did not exit successfully`);
      assert.equal(evidence.phase, "completed");
      if (mode === "recovery") {
        assert.deepEqual(evidence.connected, [1, 2], "Real UI must establish snapshot/SSE on both Core generations");
        assert.equal(evidence.spawned.length, 2);
        assert.deepEqual(evidence.spawned.map(([generation]) => generation), [1, 2], "Supervisor must spawn both Core generations");
      } else {
        assert.equal(evidence.exhausted, true);
        assert.equal(evidence.ui_exhausted, true, "UI must observe the persistent exhausted state");
        assert.equal(evidence.spawned.length, 5, "Startup retry budget must stop at five attempts");
        assert.equal(evidence.connected.length, 0);
      }
    }
    for (const [, pid] of evidence.spawned) {
      const deadline = Date.now() + 10_000;
      while (coreAlive(pid) && Date.now() < deadline) await delay(50);
      assert.equal(coreAlive(pid), false, `${mode}: Core PID ${pid} survived desktop exit`);
    }
    results.push({ mode, status: "PASS", elapsedMs: Date.now() - started, evidence });
    process.stdout.write(`PASS: ${mode}\n`);
  } catch (error) {
    results.push({ mode, status: "FAIL", elapsedMs: Date.now() - started, reason: error.message, evidence });
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null && !launchError) {
      child.kill();
      await Promise.race([exited, delay(10_000)]);
    }
    // Preserve the failed assertion before cleaning up only the test's observed children.
    for (const [, pid] of results.at(-1)?.status === "FAIL" ? evidence?.spawned ?? [] : []) {
      if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "win32") continue;
      try {
        // Windows can reuse a PID within this test. Never kill a different image
        // that subsequently acquired a recorded PID (e.g. another test worker).
        inspectWindowsCore(pid, true);
      } catch { /* The failure remains in the evidence; uncertain ownership is never killed. */ }
    }
    const status = results.length === 3 && results.every((result) => result.status === "PASS") ? "PASS" : "FAIL";
    writeFileSync(join(root, "results.json"), `${JSON.stringify({ executable: resolve(executable), status, results }, null, 2)}\n`);
  }
}

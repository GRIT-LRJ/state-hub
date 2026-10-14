import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const target = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;

async function until(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch { /* The app and installer may be replacing files. */ }
    await pause(50);
  }
  throw new Error("Updater smoke timed out");
}

function startApp(executable, root, phase, autoUpdate) {
  const runtime = join(root, `runtime-${phase}`);
  mkdirSync(runtime);
  const result = join(root, `result-${phase}.json`);
  const metrics = join(root, `metrics-${phase}.json`);
  const child = spawn(executable, [], {
    env: { ...process.env, STATE_HUB_DATA_DIR: join(root, "data"), STATE_HUB_RUNTIME_DIR: runtime,
      STATE_HUB_STARTUP_METRICS_FILE: metrics, STATE_HUB_SMOKE_AUTO_UPDATE: autoUpdate ? "1" : "0",
      STATE_HUB_SMOKE_RESULT_FILE: result },
    stdio: "ignore",
  });
  return { child, runtime, result, metrics };
}

async function healthy(running, version) {
  return await until(async () => {
    const metrics = JSON.parse(readFileSync(running.metrics, "utf8"));
    const discovery = JSON.parse(readFileSync(join(running.runtime, "discovery.json"), "utf8"));
    if (metrics.version !== version || metrics.uiFirstPaintMs == null || metrics.coreReadyMs == null) return false;
    const response = await fetch(`http://127.0.0.1:${discovery.port}/health/live`,
      { signal: AbortSignal.timeout(1500) });
    return response.ok && discovery.host === "127.0.0.1";
  });
}

async function stop(running) {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill();
    await Promise.race([new Promise((done) => running.child.once("exit", done)), pause(5000)]);
  }
}

async function run() {
  const [executable, artifact, signatureFile, invalidArtifact, invalidSignatureFile, baselineVersion, nextVersion] = process.argv.slice(2);
  for (const file of [executable, artifact, signatureFile, invalidArtifact, invalidSignatureFile]) {
    if (!file || !existsSync(file)) throw new Error("Updater smoke input is missing");
  }
  if (!baselineVersion || !nextVersion || baselineVersion === nextVersion) throw new Error("Expected distinct versions");
  const root = mkdtempSync(join(tmpdir(), "state-hub-updater-smoke-"));
  const signature = readFileSync(signatureFile, "utf8").trim();
  const invalidSignature = readFileSync(invalidSignatureFile, "utf8").trim();
  let manifest = "{}";
  let servedArtifact = artifact;
  const server = createServer((request, response) => {
    if (request.url === "/beta/latest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(manifest);
    } else if (request.url === "/artifact") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(servedArtifact).pipe(response);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(39741, "127.0.0.1", done); });
  const makeManifest = (sig) => JSON.stringify({ version: nextVersion,
    platforms: { [target]: { url: "http://127.0.0.1:39741/artifact", signature: sig } } });
  try {
    const failures = [
      { name: "malformed", body: "{invalid", expected: "manifest-rejected" },
      { name: "invalid-signature", body: makeManifest("invalid-signature"), expected: "download-or-signature-rejected" },
      { name: "invalid-installer", body: makeManifest(invalidSignature), expected: "signature-verified", invalid: true },
    ];
    for (const failure of failures) {
      manifest = failure.body;
      servedArtifact = failure.invalid ? invalidArtifact : artifact;
      const running = startApp(executable, root, failure.name, true);
      try {
        const result = await until(() => JSON.parse(readFileSync(running.result, "utf8")));
        if (failure.invalid) {
          assert.ok(["signature-verified", "install-rejected", "installed"].includes(result.phase),
            `${failure.name} updater result`);
        } else {
          assert.equal(result.phase, failure.expected, `${failure.name} updater result`);
        }
        if (failure.invalid) {
          await until(() => {
            if (running.child.exitCode !== null || running.child.signalCode !== null) return true;
            try {
              const phase = JSON.parse(readFileSync(running.result, "utf8")).phase;
              return phase === "install-rejected" || phase === "installed";
            } catch { return false; }
          }, 60_000);
          await pause(3000);
        } else {
          await healthy(running, baselineVersion);
        }
      } finally {
        await stop(running);
      }
      const fresh = startApp(executable, root, `${failure.name}-recovery`, false);
      try { await healthy(fresh, baselineVersion); }
      finally { await stop(fresh); }
      process.stdout.write(`${failure.name}: old installation remained healthy\n`);
    }
    manifest = makeManifest(signature);
    servedArtifact = artifact;
    const upgrading = startApp(executable, root, "valid-upgrade", true);
    try {
      const result = await until(() => JSON.parse(readFileSync(upgrading.result, "utf8")), 60_000);
      assert.ok(["signature-verified", "installed"].includes(result.phase));
      if (process.platform === "win32") {
        await until(() => upgrading.child.exitCode !== null || upgrading.child.signalCode !== null, 60_000);
        await pause(5000);
      } else {
        await until(() => JSON.parse(readFileSync(upgrading.result, "utf8")).phase === "installed", 60_000);
      }
    } finally {
      await stop(upgrading);
    }
    const updated = startApp(executable, root, "after-upgrade", false);
    try { await healthy(updated, nextVersion); }
    finally { await stop(updated); }
    assert.ok(existsSync(join(root, "data", "state-hub.db")), "persistent Core data survived upgrade");
    process.stdout.write(`Signed updater installed ${nextVersion}; Core data survived\n`);
  } finally {
    await new Promise((done) => server.close(done));
    const checked = realpathSync(root);
    const tempRoot = realpathSync(tmpdir());
    if (checked.startsWith(`${tempRoot}${sep}`) && checked !== tempRoot) {
      rmSync(checked, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { reportPerformanceTargets } from "../performance-policy.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForSidecarExit(runtime) {
  let pid;
  try { pid = JSON.parse(readFileSync(join(runtime, "discovery.json"), "utf8")).pid; }
  catch { return; }
  if (!Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await pause(100);
  }
  throw new Error("Installed Core sidecar survived desktop shutdown");
}

export function percentile(values, percentage) {
  if (!values.length) throw new Error("No startup measurements");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentage / 100) - 1];
}

export async function sample(executable, iteration) {
  const root = mkdtempSync(join(tmpdir(), "state-hub-installed-smoke-"));
  const runtime = join(root, "runtime");
  const metricsFile = join(root, "startup.json");
  const started = performance.now();
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      STATE_HUB_DATA_DIR: join(root, "data"),
      STATE_HUB_RUNTIME_DIR: runtime,
      STATE_HUB_STARTUP_METRICS_FILE: metricsFile,
    },
    stdio: "ignore",
  });
  const spawnReturnMs = performance.now() - started;
  try {
    const deadline = Date.now() + 15_000;
    let metrics;
    let coreReadyMs;
    let uiFirstPaintMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Installed application exited during sample ${iteration}`);
      try {
        metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
        if (metrics.coreReadyMs != null && coreReadyMs == null) coreReadyMs = performance.now() - started;
        if (metrics.uiFirstPaintMs != null && uiFirstPaintMs == null) uiFirstPaintMs = performance.now() - started;
        const discovery = JSON.parse(readFileSync(join(runtime, "discovery.json"), "utf8"));
        if (coreReadyMs != null && uiFirstPaintMs != null &&
          discovery.pid > 0 && discovery.host === "127.0.0.1" && discovery.port > 0) {
          const response = await fetch(`http://127.0.0.1:${discovery.port}/health/live`,
            { signal: AbortSignal.timeout(2000) });
          if (!response.ok) throw new Error("Installed Core health check failed");
          return { version: metrics.version, spawnReturnMs, coreReadyMs, uiFirstPaintMs,
            internalCoreReadyMs: metrics.coreReadyMs, internalUiFirstPaintMs: metrics.uiFirstPaintMs };
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Installed Core health check failed") throw error;
      }
      await pause(10);
    }
    throw new Error(`Installed application startup timed out in sample ${iteration}: ${JSON.stringify({
      processExited: child.exitCode !== null || child.signalCode !== null,
      coreReadyMs: coreReadyMs ?? null,
      uiFirstPaintMs: uiFirstPaintMs ?? null,
      discoveryPresent: existsSync(join(runtime, "discovery.json")),
    })}`);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise((done) => child.once("exit", done)), pause(5000)]);
    }
    await waitForSidecarExit(runtime);
    const checked = realpathSync(root);
    if (process.env.STATE_HUB_KEEP_SMOKE_TEMP === "1") {
      process.stderr.write(`Startup smoke temporary directory retained: ${checked}\n`);
    } else if (checked.startsWith(`${realpathSync(tmpdir())}${sep}`) && checked !== realpathSync(tmpdir())) {
      rmSync(checked, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const executable = process.argv[2];
  const count = Number(process.argv[3] ?? "20");
  if (!executable || !existsSync(executable) || !Number.isInteger(count) || count < 1) {
    throw new Error("Expected installed executable path and positive sample count");
  }
  const samples = [];
  for (let iteration = 1; iteration <= count; iteration++) {
    const result = await sample(executable, iteration);
    samples.push(result);
    process.stdout.write(`Startup sample ${iteration}: spawn ${result.spawnReturnMs}ms, Core ${result.coreReadyMs}ms, UI ${result.uiFirstPaintMs}ms ` +
      `(in-process Core ${result.internalCoreReadyMs}ms, UI ${result.internalUiFirstPaintMs}ms)\n`);
  }
  const coreP95 = percentile(samples.map((sample) => sample.coreReadyMs), 95);
  const uiP95 = percentile(samples.map((sample) => sample.uiFirstPaintMs), 95);
  process.stdout.write(`Installed startup P95: Core ${coreP95}ms, UI ${uiP95}ms (${count} samples)\n`);
  reportPerformanceTargets("installed-startup", [
    { metric: "coreReadyP95Ms", value: coreP95, max: 1000 },
    { metric: "uiFirstPaintP95Ms", value: uiP95, max: 1000 },
  ]);
}

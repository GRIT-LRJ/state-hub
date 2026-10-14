import assert from "node:assert/strict";
import { cpus, totalmem, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { CoreAcceptanceHarness } from "../src/acceptance/harness.ts";
import { statefulBenchmark } from "./stateful-benchmark.mjs";
import { reportPerformanceTargets } from "../../../tools/performance-policy.mjs";

const SOURCE_COUNT = 50;
const OUTPUT_COUNT = 50;
const BINDINGS_PER_SOURCE = 10;
const SUSTAINED_EVENTS = 500;
const BURST_EVENTS = 1_000;
const BURST_CONCURRENCY = 64;
const RECOVERY_EVENTS = 100;
const PACING_MS = 10;

function quantiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => Number((sorted[Math.ceil(sorted.length * fraction) - 1] ?? Infinity).toFixed(2));
  return { count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99),
    maxMs: Number((sorted.at(-1) ?? Infinity).toFixed(2)) };
}

async function completedSamples(promises, phase) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((item) => item.status === "rejected");
  if (failed) throw new Error(`${phase} request failed`, { cause: failed.reason });
  return settled.map((item) => item.value);
}

function configuration() {
  const driverInstances = Array.from({ length: OUTPUT_COUNT }, (_, output) => ({
    id: `virtual-${output}`, driverType: "virtual", enabled: true, config: {},
  }));
  const bindings = Array.from({ length: SOURCE_COUNT }, (_, source) =>
    Array.from({ length: BINDINGS_PER_SOURCE }, (_, scope) => ({
      id: `binding-${source}-${scope}`, name: `Load ${source}/${scope}`, enabled: true,
      selector: { producerId: `load-${source}`, eventType: "custom", scopePattern: `scope-${scope}` },
      conditions: [], mapping: { index: { kind: "pointer", pointer: "/index" } },
      target: { driverInstanceId: `virtual-${source}`, resourceChannel: "events",
        actionKind: "append-only", actionName: "notify" },
      batchWindowMs: 0,
    }))).flat();
  return { bindings, driverInstances };
}

function deliveredCount(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare("SELECT count(*) AS count FROM deliveries WHERE status = 'delivered'").get().count;
  } finally {
    database.close();
  }
}

function deliveryStatuses(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare("SELECT status, count(*) AS count FROM deliveries GROUP BY status ORDER BY status").all();
  } finally {
    database.close();
  }
}

async function waitForDispatcher(harness, expected, phase) {
  const started = performance.now();
  try {
    await harness.waitFor(async () => {
      const snapshot = await harness.admin.snapshot();
      return snapshot.pendingDeliveries === 0 && deliveredCount(harness.paths.database) === expected || false;
    }, { timeoutMs: 60_000, intervalMs: 50, description: `${phase} dispatcher to deliver ${expected} actions` });
  } catch (error) {
    const snapshot = await harness.admin.snapshot();
    throw new Error(`${phase} delivery status: ${JSON.stringify({
      expected, pending: snapshot.pendingDeliveries, deadLetters: snapshot.deadLetters,
      statuses: deliveryStatuses(harness.paths.database),
    })}`, { cause: error });
  }
  return Number((performance.now() - started).toFixed(2));
}

async function main() {
  const result = { schemaVersion: 1, environment: {
    platform: platform(), architecture: arch(), node: process.version,
    cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  }, dimensions: { sources: SOURCE_COUNT, outputs: OUTPUT_COUNT,
    bindings: SOURCE_COUNT * BINDINGS_PER_SOURCE }, phases: {} };
  const harness = await CoreAcceptanceHarness.start({ cpuProfileDirectory: process.env.STATE_HUB_PERF_PROFILE_DIR });
  let stage = "setup";
  try {
    const producers = [];
    const setupStarted = performance.now();
    for (let source = 0; source < SOURCE_COUNT; source += 1) {
      producers.push(await harness.admin.createProducer(`load-${source}`, "official.custom-http"));
    }
    result.phases.producerRegistrationMs = Number((performance.now() - setupStarted).toFixed(2));
    const config = configuration();
    assert.equal(config.bindings.length, 500);
    assert.equal(config.driverInstances.length, 50);
    const publishStarted = performance.now();
    await harness.admin.publishConfig(config);
    result.phases.configPublishMs = Number((performance.now() - publishStarted).toFixed(2));
    result.phases.setupMs = Number((performance.now() - setupStarted).toFixed(2));

    async function send(phase, index) {
      const producerIndex = index % SOURCE_COUNT;
      const scope = Math.floor(index / SOURCE_COUNT) % BINDINGS_PER_SOURCE;
      const producer = producers[producerIndex];
      const started = performance.now();
      const response = await producer.fetch(`/api/v1/producers/${producer.producerId}/events`, {
        method: "POST", signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ eventId: `${phase}-${index}`, type: "custom",
          scopeId: `scope-${scope}`, value: { index } }),
      });
      const elapsed = performance.now() - started;
      assert.equal(response.status, 202, `${phase} HTTP input returned ${response.status}`);
      await response.arrayBuffer();
      return elapsed;
    }

    stage = "warmup";
    const warmup = await completedSamples(Array.from({ length: SOURCE_COUNT },
      (_, index) => send("warmup", index)), "warmup");
    result.phases.warmup = quantiles(warmup);
    result.phases.warmup.dispatcherDrainMs = await waitForDispatcher(harness, SOURCE_COUNT, "warmup");

    stage = "sustained";
    const sustainedStart = performance.now();
    const sustained = [];
    for (let index = 0; index < SUSTAINED_EVENTS; index += 1) {
      const remaining = sustainedStart + index * PACING_MS - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      sustained.push(send("sustained", index));
    }
    const sustainedSamples = await completedSamples(sustained, "sustained");
    const sustainedElapsedMs = performance.now() - sustainedStart;
    result.phases.sustained = { ...quantiles(sustainedSamples),
      elapsedMs: Number(sustainedElapsedMs.toFixed(2)),
      acceptedPerSecond: Number((SUSTAINED_EVENTS * 1_000 / sustainedElapsedMs).toFixed(2)) };
    result.phases.sustained.pendingAfterAcceptance = (await harness.admin.snapshot()).pendingDeliveries;
    result.phases.sustained.dispatcherDrainMs = await waitForDispatcher(
      harness, SOURCE_COUNT + SUSTAINED_EVENTS, "sustained");

    stage = "burst";
    const burstStart = performance.now();
    const burstSamples = [];
    for (let offset = 0; offset < BURST_EVENTS; offset += BURST_CONCURRENCY) {
      burstSamples.push(...await completedSamples(Array.from({
        length: Math.min(BURST_CONCURRENCY, BURST_EVENTS - offset),
      }, (_, index) => send("burst", offset + index)), "burst"));
    }
    assert.equal(burstSamples.length, BURST_EVENTS);
    result.phases.burst = { ...quantiles(burstSamples),
      concurrency: BURST_CONCURRENCY, elapsedMs: Number((performance.now() - burstStart).toFixed(2)) };
    result.phases.burst.pendingAfterAcceptance = (await harness.admin.snapshot()).pendingDeliveries;
    result.phases.burst.dispatcherDrainMs = await waitForDispatcher(
      harness, SOURCE_COUNT + SUSTAINED_EVENTS + BURST_EVENTS, "burst");

    stage = "recovery";
    await harness.crash();
    const restartStart = performance.now();
    await harness.restart();
    result.phases.restartMs = Number((performance.now() - restartStart).toFixed(2));
    const recoveryStart = performance.now();
    const recovered = [];
    for (let index = 0; index < RECOVERY_EVENTS; index += 1) {
      const remaining = recoveryStart + index * PACING_MS - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      recovered.push(send("recovery", index));
    }
    result.phases.recovery = quantiles(await completedSamples(recovered, "recovery"));
    result.phases.recovery.dispatcherDrainMs = await waitForDispatcher(
      harness, SOURCE_COUNT + SUSTAINED_EVENTS + BURST_EVENTS + RECOVERY_EVENTS, "recovery");
    result.delivered = deliveredCount(harness.paths.database);
    result.deadLetters = (await harness.admin.snapshot()).deadLetters;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    assert.equal(result.delivered, SOURCE_COUNT + SUSTAINED_EVENTS + BURST_EVENTS + RECOVERY_EVENTS);
    assert.equal(result.deadLetters, 0);
    reportPerformanceTargets("event-input", [
      { metric: "sustainedAcceptedPerSecond", value: result.phases.sustained.acceptedPerSecond, min: 99 },
      ...["sustained", "burst", "recovery"].map((phase) => ({
        metric: `${phase}P95Ms`, value: result.phases[phase].p95Ms, max: 100,
      })),
    ]);
  } catch (error) {
    process.stderr.write(`Performance stage ${stage} failed; Core running: ${harness.isRunning}\n`);
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${harness.stderrOutput.slice(-4_000)}\n`);
    throw error;
  } finally {
    await harness.dispose();
  }
}

await main();
await statefulBenchmark();

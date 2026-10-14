import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpus, totalmem, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreAcceptanceHarness } from "../src/acceptance/harness.ts";
import { reportPerformanceTargets } from "../../../tools/performance-policy.mjs";

const SOURCES = 50;
const SCOPES = 10;
const CONCURRENCY = 64;
const quantiles = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => Number(sorted[Math.ceil(sorted.length * q) - 1].toFixed(2));
  return { count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) };
};

export async function statefulBenchmark() {
  const received = [];
  const target = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({ output: request.url.slice(1), ...JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${target.address().port}`;
  const result = { scenario: "stateful", environment: { platform: platform(), arch: arch(), node: process.version,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    dimensions: { sources: SOURCES, outputs: SOURCES, bindings: SOURCES * SCOPES, activeClaims: SOURCES * SCOPES,
      sseSubscribers: 0, burstConcurrency: CONCURRENCY }, phases: {} };
  let harness;
  let stage = "setup";
  try {
    harness = await CoreAcceptanceHarness.start({ cpuProfileDirectory: process.env.STATE_HUB_PERF_PROFILE_DIR });
    const producers = [];
    for (let source = 0; source < SOURCES; source++) {
      producers.push(await harness.admin.createProducer(`state-${source}`, "official.custom-http"));
    }
    await harness.admin.publishConfig({
      driverInstances: Array.from({ length: SOURCES }, (_, source) => ({
        id: `output-${source}`, driverType: "official.http", enabled: true,
        config: { baseUrl: `${origin}/output-${source}`, privateTargetOrigin: origin },
      })),
      bindings: producers.flatMap((producer, source) => Array.from({ length: SCOPES }, (_, scope) => ({
        id: `state-${source}-${scope}`, name: `State ${source}/${scope}`, enabled: true,
        selector: { producerId: producer.producerId, signalId: "custom", scopePattern: `scope-${scope}` },
        conditions: [], mapping: { index: { kind: "pointer", pointer: "/index" }, phase: { kind: "pointer", pointer: "/phase" } },
        target: { driverInstanceId: `output-${source}`, resourceChannel: "state", actionKind: "stateful", actionName: "project" },
      }))),
    });
    async function send(phase, index) {
      const producer = producers[index % SOURCES];
      const scope = Math.floor(index / SOURCES) % SCOPES;
      const started = performance.now();
      const response = await producer.fetch(`/api/v1/producers/${producer.producerId}/scopes/scope-${scope}/claims/custom`, {
        method: "PUT", signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ value: { phase, index }, urgency: "informational" }),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 202, `${phase}: rejected state input`);
      return performance.now() - started;
    }
    async function run(phase, count, paced) {
      stage = phase;
      process.stdout.write(`Stateful phase ${phase}: ${count} inputs\n`);
      const started = performance.now();
      const samples = [];
      if (paced) {
        const pending = [];
        for (let index = 0; index < count; index++) {
          const delay = started + index * 10 - performance.now();
          if (delay > 0) await new Promise((done) => setTimeout(done, delay));
          // Attach rejection handlers immediately, including during the paced submission loop.
          pending.push(send(phase, index).then((value) => ({ value }), (error) => ({ error })));
        }
        for (const item of await Promise.all(pending)) {
          if (item.error) throw item.error;
          samples.push(item.value);
        }
      } else {
        for (let offset = 0; offset < count; offset += CONCURRENCY) {
          const batch = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, count - offset) },
            (_, index) => send(phase, offset + index)));
          for (const item of batch) {
            if (item.status === "rejected") throw item.reason;
            samples.push(item.value);
          }
        }
      }
      const elapsedMs = performance.now() - started;
      const phaseResult = { ...quantiles(samples), elapsedMs: Number(elapsedMs.toFixed(2)),
        acceptedPerSecond: Number((count * 1000 / elapsedMs).toFixed(2)),
        pendingAfterAcceptance: (await harness.admin.snapshot()).pendingDeliveries };
      result.phases[phase] = phaseResult;
      await verifyProjection(phase);
      phaseResult.driverInvocationCount = received.length;
    }
    async function verifyProjection(phase, receivedSince = 0) {
      const started = performance.now();
      const snapshot = await harness.waitFor(async () => {
        const current = await harness.admin.snapshot();
        return current.pendingDeliveries === 0 && current;
      }, { timeoutMs: 60_000, description: `${phase}: stateful dispatcher drain` });
      assert.equal(snapshot.deadLetters, 0);
      assert.equal(snapshot.claims.length, SOURCES * SCOPES);
      assert.equal(snapshot.projections.length, SOURCES);
      for (let source = 0; source < SOURCES; source++) {
        const claims = snapshot.claims.filter((claim) => claim.producerId === `state-${source}`);
        const winner = claims.reduce((a, b) => a.revision > b.revision ? a : b);
        const projection = snapshot.projections.find((entry) => entry.driverInstanceId === `output-${source}`);
        assert.deepEqual(projection.action.params, winner.value, `${phase}: wrong arbitration winner`);
        const calls = received.slice(receivedSince).filter((call) => call.output === projection.driverInstanceId);
        assert.ok(calls.length > 0, `${phase}: HTTP target was never called`);
        assert.deepEqual(calls.at(-1).action, projection.action, `${phase}: target differs from committed projection`);
        assert.equal(calls.at(-1).projectionRevision, projection.revision);
        assert.ok(calls.every((call, index) => index === 0 || call.projectionRevision >= calls[index - 1].projectionRevision),
          `${phase}: stale output applied after newer revision`);
      }
      if (result.phases[phase]) result.phases[phase].dispatcherDrainMs = Number((performance.now() - started).toFixed(2));
    }
    await run("warmup", 500, false);
    await run("sustained", 500, true);
    await run("burst", 1000, false);
    stage = "restart";
    const beforeRestart = received.length;
    await harness.crash();
    const restartStarted = performance.now();
    await harness.restart();
    result.restartMs = Number((performance.now() - restartStarted).toFixed(2));
    await verifyProjection("restart", beforeRestart);
    assert.ok(received.length >= beforeRestart + SOURCES, "Restart did not replay every current resource to the real target");
    await run("recovery", 100, true);
    result.driverInvocationCount = received.length;
    result.performance = reportPerformanceTargets("stateful-input", [
      { metric: "sustainedAcceptedPerSecond", value: result.phases.sustained.acceptedPerSecond, min: 99 },
      ...["sustained", "burst", "recovery"].map((phase) => ({
        metric: `${phase}P95Ms`, value: result.phases[phase].p95Ms, max: 100,
      })),
    ]);
    result.status = "FUNCTIONAL_PASS";
  } catch (error) {
    result.status = "FAIL";
    result.failedStage = stage;
    process.stderr.write(`Core running: ${harness?.isRunning}\n${harness?.stderrOutput.slice(-4000) ?? ""}\n`);
    throw error;
  } finally {
    try {
      try { await harness?.dispose(); }
      finally { await new Promise((resolve) => target.close(resolve)); }
    } catch (error) {
      result.status = "FAIL";
      result.failedStage = "cleanup";
      throw error;
    } finally { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await statefulBenchmark();
}

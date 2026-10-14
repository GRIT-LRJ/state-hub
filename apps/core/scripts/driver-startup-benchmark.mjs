import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { CoreAcceptanceHarness } from "../src/acceptance/harness.ts";
import { reportPerformanceTargets } from "../../../tools/performance-policy.mjs";

const SAMPLES = 20;
const times = [];

for (let index = 0; index < SAMPLES; index++) {
  const harness = await CoreAcceptanceHarness.start();
  try {
    const producer = await harness.admin.createProducer(`driver-startup-${index}`, "official.custom-http");
    const started = performance.now();
    await harness.admin.publishConfig({
      driverInstances: [{ id: "virtual-main", driverType: "virtual", config: {}, enabled: true }],
      bindings: [{ id: "virtual-startup", name: "First virtual delivery", enabled: true,
        selector: { producerId: producer.producerId, eventType: "custom" }, conditions: [],
        mapping: { sample: { kind: "constant", value: index } },
        target: { driverInstanceId: "virtual-main", resourceChannel: "startup",
          actionKind: "append-only", actionName: "notify" }, batchWindowMs: 0 }],
    });
    const response = await producer.fetch(`/api/v1/producers/${producer.producerId}/events`, {
      method: "POST", body: JSON.stringify({ eventId: `first-${index}`, type: "custom",
        scopeId: "sample", value: { sample: index } }),
    });
    assert.equal(response.status, 202);
    await harness.waitFor(() => {
      const db = new Database(harness.paths.database, { readonly: true, fileMustExist: true });
      try {
        return db.prepare("SELECT count(*) AS count FROM deliveries WHERE status = 'delivered'").get().count === 1;
      } finally { db.close(); }
    }, { timeoutMs: 5000, intervalMs: 10, description: "first virtual driver delivery" });
    times.push(Number((performance.now() - started).toFixed(2)));
  } finally {
    await harness.dispose();
  }
}

const sorted = [...times].sort((a, b) => a - b);
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
process.stdout.write(`Driver publish-to-first-delivery (${SAMPLES} cold starts): P95 ${p95}ms, max ${sorted.at(-1)}ms\n`);
reportPerformanceTargets("driver-startup", [{ metric: "publishToFirstDeliveryP95Ms", value: p95, max: 1000 }]);

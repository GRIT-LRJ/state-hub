import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { reportPerformanceTargets } from "./performance-policy.mjs";

test("slow but successful work is reported without failing functional acceptance", () => {
  let output = "";
  const report = reportPerformanceTargets("startup", [{ metric: "uiP95Ms", value: 4500, max: 1000 }],
    { enforce: false, write: (line) => { output += line; } });
  assert.equal(report.referenceTargetsMet, false);
  assert.equal(JSON.parse(output).mode, "reference-only");
});

test("explicit target enforcement still rejects latency and throughput violations", () => {
  const options = { enforce: true, write() {} };
  assert.throws(() => reportPerformanceTargets("input", [{ metric: "p95Ms", value: 101, max: 100 }], options));
  assert.throws(() => reportPerformanceTargets("input", [{ metric: "rate", value: 90, min: 99 }], options));
  assert.doesNotThrow(() => reportPerformanceTargets("input", [
    { metric: "p95Ms", value: 100, max: 100 }, { metric: "rate", value: 100, min: 99 },
  ], options));
});

test("missing or invalid measurements fail even in reference mode", () => {
  const options = { enforce: false, write() {} };
  for (const measurements of [[], [{ metric: "p95Ms", value: NaN, max: 100 }],
    [{ metric: "p95Ms", value: Infinity, max: 100 }], [{ metric: "p95Ms", value: 1 }]]) {
    assert.throws(() => reportPerformanceTargets("input", measurements, options));
  }
});

test("CLI default reports a miss, opt-in fails it, and functional errors always fail", () => {
  const script = `import { reportPerformanceTargets } from ${JSON.stringify(new URL("./performance-policy.mjs", import.meta.url).href)};
    reportPerformanceTargets('startup', [{ metric: 'uiP95Ms', value: 4500, max: 1000 }]);`;
  const run = (enforce, extra = "") => spawnSync(process.execPath, ["--input-type=module", "-e", script + extra], {
    env: { ...process.env, STATE_HUB_ENFORCE_PERFORMANCE_TARGETS: enforce }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(run("").status, 0);
  assert.equal(run("1").status, 1);
  assert.equal(run("", "; throw new Error('Core failed to start');").status, 1);
});

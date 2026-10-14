// Numeric targets are provisional until the workload and reference hardware are agreed.
// Functional assertions and bounded startup/recovery timeouts remain mandatory.
export function reportPerformanceTargets(scope, measurements, {
  enforce = process.env.STATE_HUB_ENFORCE_PERFORMANCE_TARGETS === "1",
  write = (line) => process.stdout.write(line),
} = {}) {
  if (!measurements.length) throw new Error(`${scope}: no performance measurements`);
  const results = measurements.map(({ metric, value, min, max }) => {
    if (!metric || !Number.isFinite(value) || value < 0 ||
      (min === undefined) === (max === undefined) || !Number.isFinite(min ?? max)) {
      throw new Error(`${scope}: invalid performance measurement ${metric}`);
    }
    return { metric, value, ...(min === undefined ? { max } : { min }),
      withinReference: min === undefined ? value <= max : value >= min };
  });
  const report = { scope, mode: enforce ? "enforce-provisional-targets" : "reference-only",
    referenceTargetsMet: results.every((entry) => entry.withinReference), measurements: results };
  write(`${JSON.stringify(report, null, 2)}\n`);
  if (enforce && !report.referenceTargetsMet) {
    throw new Error(`${scope}: provisional performance target exceeded`);
  }
  return report;
}

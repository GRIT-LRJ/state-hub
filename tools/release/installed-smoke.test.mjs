import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile } from "./installed-smoke.mjs";

test("startup gate uses the upper nearest-rank P95", () => {
  assert.equal(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95), 19);
  assert.equal(percentile([800, 1200], 95), 1200);
  assert.throws(() => percentile([], 95));
});

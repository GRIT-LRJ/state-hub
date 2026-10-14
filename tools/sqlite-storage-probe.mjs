// Diagnostic only: this never changes the application's SQLite durability or gates.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const Database = createRequire(new URL("../apps/core/package.json", import.meta.url))("better-sqlite3");
const locations = [
  ["os-temp", tmpdir()],
  ["runner-temp", process.env.RUNNER_TEMP ?? process.cwd()],
];
const reports = [];
for (const [location, parent] of locations) {
  const root = mkdtempSync(join(resolve(parent), "state-hub-storage-probe-"));
  let db;
  try {
    db = new Database(join(root, "probe.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    assert.equal(db.pragma("synchronous", { simple: true }), 2);
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO probe VALUES (?, ?)");
    const commit = db.transaction((index) => insert.run(index, "synthetic-storage-probe"));
    const samples = [];
    const cpu = process.cpuUsage();
    const started = performance.now();
    for (let index = 0; index < 500; index++) {
      const start = performance.now();
      commit(index);
      samples.push(performance.now() - start);
    }
    const elapsedMs = performance.now() - started;
    const usedCpu = process.cpuUsage(cpu);
    samples.sort((left, right) => left - right);
    reports.push({ location, parent: resolve(parent), count: samples.length, synchronous: "FULL", journalMode: "WAL",
      elapsedMs, cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      p50Ms: samples[249], p95Ms: samples[474], p99Ms: samples[494], maxMs: samples.at(-1) });
  } finally {
    db?.close();
    // Remove only the fresh, verified child directory created above.
    assert.equal(dirname(root), resolve(parent));
    assert.ok(root.startsWith(join(resolve(parent), "state-hub-storage-probe-")));
    rmSync(root, { recursive: true });
  }
}
process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, reports }, null, 2)}\n`);

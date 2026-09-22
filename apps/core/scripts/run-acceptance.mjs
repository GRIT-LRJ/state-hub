import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const files = readdirSync(join(coreRoot, "src", "acceptance"))
  .filter((name) => name.endsWith(".acceptance.test.ts"))
  .sort()
  .map((name) => `src/acceptance/${name}`);
if (files.length === 0) throw new Error("No Core acceptance tests found");

// Native subprocess tests on Windows can terminate a reused Vitest fork.
// Run every discovered file in a new fork while preserving the full suite.
for (let index = 0; index < files.length; index += 1) {
  const file = files[index];
  process.stdout.write(`Core acceptance ${index + 1}/${files.length}: ${file}\n`);
  const result = spawnSync(process.execPath,
    [vitest, "run", file, "--pool=forks", "--maxWorkers=1"],
    { cwd: coreRoot, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) {
    if (result.error) process.stderr.write(`Could not start Vitest: ${result.error.message}\n`);
    process.exitCode = result.status ?? 1;
    break;
  }
}

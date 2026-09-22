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

// Native subprocess tests on Windows can exhaust one long-lived Vitest fork.
// Fresh forks per small batch keep the full suite deterministic and discover new files automatically.
for (let offset = 0; offset < files.length; offset += 5) {
  const batch = files.slice(offset, offset + 5);
  process.stdout.write(`Core acceptance batch ${Math.floor(offset / 5) + 1}: ${batch.length} files\n`);
  const result = spawnSync(process.execPath,
    [vitest, "run", ...batch, "--pool=forks", "--maxWorkers=1"],
    { cwd: coreRoot, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) {
    if (result.error) process.stderr.write(`Could not start Vitest: ${result.error.message}\n`);
    process.exitCode = result.status ?? 1;
    break;
  }
}

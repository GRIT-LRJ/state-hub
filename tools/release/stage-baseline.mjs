import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "apps/desktop/src-tauri/target/release/bundle");
const destination = resolve(root, ".release-smoke/baseline-bundle");
if (!existsSync(source) || existsSync(destination)) throw new Error("Baseline bundle missing or already staged");
cpSync(source, destination, { recursive: true });
process.stdout.write("Staged baseline native installer before the candidate build\n");

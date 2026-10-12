// Verify exactly the staged Git tree, without using the working tree's dist or node_modules.
// Evidence and the exported checkout are retained under the OS temporary directory.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join, resolve } from "node:path";

const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const tree = git("write-tree");
const root = mkdtempSync(join(tmpdir(), "state-hub-candidate-"));
const checkout = join(root, "checkout");
mkdirSync(checkout);
const archive = join(root, "source.tar");
git("archive", "--format=tar", `--output=${archive}`, tree);
execFileSync("tar", ["-xf", archive, "-C", checkout]);
const evidence = {
  schemaVersion: 1, tree, parentCommit: git("rev-parse", "HEAD"),
  startedAt: new Date().toISOString(),
  environment: { platform: platform(), arch: arch(), node: process.version },
  lockfileSha256: createHash("sha256").update(readFileSync(join(checkout, "pnpm-lock.yaml"))).digest("hex"),
  checkout, commands: [], result: "FAIL",
};
const manifest = join(root, "evidence.json");
const save = () => writeFileSync(manifest, `${JSON.stringify(evidence, null, 2)}\n`);
save();
process.stdout.write(`Candidate tree: ${tree}\nEvidence: ${manifest}\n`);
// Only fixed commands are executed through cmd on Windows; no user input becomes shell code.
const commands = ["pnpm install --frozen-lockfile", "pnpm test", "pnpm test:acceptance", "pnpm check", "pnpm build"];
for (const [index, command] of commands.entries()) {
  const log = join(root, `${index}-${command.split(" ")[1].replaceAll(":", "-")}.log`);
  const descriptor = openSync(log, "w");
  const startedAt = new Date().toISOString();
  process.stdout.write(`Running ${command}\n`);
  let result;
  try {
    result = process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
        cwd: checkout, stdio: ["ignore", descriptor, descriptor], windowsHide: true,
      })
      : spawnSync("pnpm", command.split(" ").slice(1), {
        cwd: checkout, stdio: ["ignore", descriptor, descriptor],
      });
  } finally { closeSync(descriptor); }
  evidence.commands.push({ command, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, launchFailed: Boolean(result.error), log });
  save();
  if (result.status !== 0 || result.error) {
    process.stderr.write(`FAIL: ${command}; inspect ${log}\n`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) {
  // A concurrent index change invalidates the candidate verdict rather than silently widening its scope.
  evidence.result = git("write-tree") === tree ? "PASS" : "INDEX_CHANGED";
  if (evidence.result !== "PASS") process.exitCode = 1;
}
evidence.finishedAt = new Date().toISOString();
save();
process.stdout.write(`${evidence.result}: ${resolve(manifest)}\n`);

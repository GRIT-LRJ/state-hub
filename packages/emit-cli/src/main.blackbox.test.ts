import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommand, spool } from "./main.js";

const packageRoot = resolve(process.cwd());
const main = join(packageRoot, "dist", "main.js");
const hook = join(packageRoot, "dist", "codex-hook.js");
const crashPreload = join(packageRoot, "tests", "crash-preload.mjs");
const keyringFailurePreload = join(packageRoot, "tests", "keyring-failure-preload.mjs");
const roots: string[] = [];

function paths() {
  const root = mkdtempSync(join(tmpdir(), "state-hub-emit-test-"));
  roots.push(root);
  const data = join(root, "data");
  const runtime = join(root, "runtime");
  mkdirSync(runtime, { recursive: true });
  return { root, data, runtime, spool: join(data, "spool") };
}

function env(data: string, runtime: string): NodeJS.ProcessEnv {
  return { ...process.env, STATE_HUB_DATA_DIR: data, STATE_HUB_RUNTIME_DIR: runtime,
    STATE_HUB_PRODUCER_TOKEN: "test-producer-token" };
}

function files(directory: string, suffix: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(suffix));
}

async function runNode(script: string, environment: NodeJS.ProcessEnv,
  options: { preload?: string; input?: string | null; args?: string[] } = {}): Promise<{ code: number | null; stderr: string }> {
  return await new Promise((resolveRun, reject) => {
    const args = options.preload ? ["--import", pathToFileURL(options.preload).href, script, ...(options.args ?? [])] : [script, ...(options.args ?? [])];
    const child = spawn(process.execPath, args, { cwd: packageRoot, env: environment });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 4_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, stderr });
    });
    if (options.input !== null) child.stdin.end(options.input ?? "");
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("spool-first CLI process contract", () => {
  it("keeps producer event IDs out of filesystem paths", () => {
    const fixture = paths();
    const command = parseCommand(["event", "codex", "tool.failed",
      '{"message":"test"}', "session", "../../escape"]);
    expect(command).not.toBe("drain");
    if (command === "drain") return;
    command.createdAt = "../../outside-spool";
    const path = spool(command, fixture.spool);
    expect(path.startsWith(fixture.spool)).toBe(true);
    expect(path).not.toContain("escape");
    expect((JSON.parse(readFileSync(path, "utf8")) as { id: string }).id).toBe("../../escape");
    expect(files(fixture.spool, ".tmp")).toEqual([]);
  });

  it.each(["before-rename", "after-rename"] as const)(
    "survives a process crash %s without exposing a partial command to drain", (point) => {
      const fixture = paths();
      const environment = { ...env(fixture.data, fixture.runtime), STATE_HUB_TEST_CRASH_POINT: point };
      const crashed = spawnSync(process.execPath,
        ["--import", pathToFileURL(crashPreload).href, main, "claim", "codex", "session",
          "status", '{"value":{"phase":"decision"}}'],
        { cwd: packageRoot, env: environment, encoding: "utf8", timeout: 4_000 });
      expect(crashed.status).toBe(point === "before-rename" ? 73 : 74);
      expect(files(fixture.spool, ".json")).toHaveLength(point === "before-rename" ? 0 : 1);
      expect(files(fixture.spool, ".tmp")).toHaveLength(point === "before-rename" ? 1 : 0);
      const drain = spawnSync(process.execPath, [main, "drain"],
        { cwd: packageRoot, env: environment, encoding: "utf8", timeout: 4_000 });
      expect(drain.status).toBe(0);
      expect(files(fixture.spool, ".json")).toHaveLength(point === "before-rename" ? 0 : 1);
    },
  );

  it("keeps the spooled command when the OS credential lookup fails without leaking its error", () => {
    const fixture = paths();
    const environment = env(fixture.data, fixture.runtime);
    delete environment.STATE_HUB_PRODUCER_TOKEN;
    writeFileSync(join(fixture.runtime, "discovery.json"),
      JSON.stringify({ host: "127.0.0.1", port: 43210 }));
    const child = spawnSync(process.execPath,
      ["--import", pathToFileURL(keyringFailurePreload).href, main, "claim", `missing-${randomUUID()}`,
        "session", "status", '{"value":{"phase":"decision"}}'],
      { cwd: packageRoot, env: environment, encoding: "utf8", timeout: 4_000 });
    expect(child.status).toBe(0);
    expect(child.stderr).not.toContain("TEST_SECRET_MUST_NOT_APPEAR");
    expect(files(fixture.spool, ".json")).toHaveLength(1);
  });

  it("rejects a discovery address outside the loopback contract before sending a token", () => {
    const fixture = paths();
    writeFileSync(join(fixture.runtime, "discovery.json"),
      JSON.stringify({ host: "example.test", port: 80 }));
    const child = spawnSync(process.execPath,
      [main, "claim", "codex", "session", "status", '{"value":{"phase":"working"}}'],
      { cwd: packageRoot, env: env(fixture.data, fixture.runtime), encoding: "utf8", timeout: 4_000 });
    expect(child.status).toBe(0);
    expect(files(fixture.spool, ".json")).toHaveLength(1);
  });

  it("bounds a stalled loopback request to 800ms and retains the command", async () => {
    const fixture = paths();
    let calls = 0;
    const receiver = createServer(async (request) => {
      for await (const _chunk of request) { /* consume body and leave response pending */ }
      calls += 1;
    });
    await new Promise<void>((resolveListen) => receiver.listen(0, "127.0.0.1", resolveListen));
    writeFileSync(join(fixture.runtime, "discovery.json"),
      JSON.stringify({ host: "127.0.0.1", port: (receiver.address() as AddressInfo).port }));
    try {
      const started = performance.now();
      const child = await runNode(main, env(fixture.data, fixture.runtime), {
        args: ["claim", "codex", "session", "status", '{"value":{"phase":"decision"}}'],
      });
      const elapsed = performance.now() - started;
      expect(child.code).toBe(0);
      expect(calls).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(700);
      expect(elapsed).toBeLessThan(1_800);
      expect(files(fixture.spool, ".json")).toHaveLength(1);
    } finally {
      receiver.closeAllConnections();
      await new Promise<void>((resolveClose) => receiver.close(() => resolveClose()));
    }
  }, 8_000);

  it("fails open on invalid hook input and bounds an unclosed stdin", async () => {
    const fixture = paths();
    const environment = env(fixture.data, fixture.runtime);
    const malformed = await runNode(hook, environment, {
      input: '{"message":"Authorization: Bearer TEST_SECRET_MUST_NOT_APPEAR"',
    });
    expect(malformed.code).toBe(0);
    expect(malformed.stderr).toContain("HOOK_FAILED");
    expect(malformed.stderr).not.toContain("TEST_SECRET_MUST_NOT_APPEAR");

    const started = performance.now();
    const stalled = await runNode(hook, environment, { input: null });
    expect(stalled.code).toBe(0);
    expect(stalled.stderr).toContain("HOOK_FAILED");
    expect(performance.now() - started).toBeLessThan(1_800);
  }, 8_000);
});

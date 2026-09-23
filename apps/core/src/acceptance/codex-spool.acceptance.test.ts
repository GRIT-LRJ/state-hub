import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const cliRoot = resolve(import.meta.dirname, "../../../../packages/emit-cli");
const cli = join(cliRoot, "dist", "main.js");
const hook = join(cliRoot, "dist", "codex-hook.js");

function environment(harness: CoreAcceptanceHarness, token: string, runtime = harness.paths.runtime): NodeJS.ProcessEnv {
  return { ...process.env, STATE_HUB_DATA_DIR: harness.paths.data,
    STATE_HUB_RUNTIME_DIR: runtime, STATE_HUB_PRODUCER_TOKEN: token };
}

function runSync(script: string, args: string[], env: NodeJS.ProcessEnv, input?: string): void {
  const result = spawnSync(process.execPath, [script, ...args],
    { cwd: cliRoot, env, input, encoding: "utf8", timeout: 4_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

async function runAsync(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: cliRoot, env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`CLI exited ${code}: ${stderr}`)));
  });
}

function spooled(harness: CoreAcceptanceHarness): string[] {
  return readdirSync(join(harness.paths.data, "spool")).filter((name) => name.endsWith(".json"));
}

describe("Codex spool-first against the real Core", () => {
  it("recovers an offline hook, keeps sessions separate, and arbitrates their shared output", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("codex", "official.codex");
      const binding: Binding = {
        id: "codex-status", name: "Codex status", enabled: true,
        selector: { producerId: "codex", signalId: "status", scopePattern: "*" },
        conditions: [], mapping: { phase: { kind: "pointer", pointer: "/phase" } },
        target: { driverInstanceId: "virtual-main", resourceChannel: "shared-light",
          actionKind: "stateful", actionName: "render" },
      };
      await harness.admin.publishConfig({ bindings: [binding],
        driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }] });
      const env = environment(harness, producer.token);
      const sendHook = (hook_event_name: string, session_id: string) => runSync(hook, [], env,
        JSON.stringify({ hook_event_name, session_id, turn_id: `turn-${session_id}` }));
      const projection = async () => (await harness.admin.snapshot()).projections
        .find((item) => item.resourceChannel === "shared-light");

      sendHook("UserPromptSubmit", "session-a");
      await harness.waitFor(async () => (await projection())?.action?.params.phase === "working" || false);
      expect(spooled(harness)).toHaveLength(0);

      await harness.crash();
      sendHook("PermissionRequest", "session-b");
      expect(spooled(harness)).toHaveLength(1);
      await harness.restart();
      await Promise.all([runAsync(cli, ["drain"], env), runAsync(cli, ["drain"], env)]);
      await harness.waitFor(async () => (await projection())?.action?.params.phase === "decision" || false);
      expect(spooled(harness)).toHaveLength(0);
      const claims = (await harness.admin.snapshot()).claims;
      expect(claims).toContainEqual(expect.objectContaining({ producerId: "codex", scopeId: "session-a",
        signalId: "status", value: { phase: "working", turnId: "turn-session-a" } }));
      expect(claims).toContainEqual(expect.objectContaining({ producerId: "codex", scopeId: "session-b",
        signalId: "status", value: { phase: "decision", turnId: "turn-session-b" } }));

      sendHook("SessionEnd", "session-b");
      await harness.waitFor(async () => (await projection())?.action?.params.phase === "working" || false);
      expect(spooled(harness)).toHaveLength(0);
      expect((await harness.admin.snapshot()).claims.some((claim) => claim.scopeId === "session-b")).toBe(false);
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("deduplicates concurrent and repeated drain before an append-only HTTP side effect", async () => {
    let invocations = 0;
    const receiver = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume body */ }
      invocations += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolveListen) => receiver.listen(0, "127.0.0.1", resolveListen));
    const origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("codex", "official.codex");
      await harness.admin.publishConfig({
        bindings: [{ id: "codex-failure", name: "Codex failure", enabled: true,
          selector: { producerId: "codex", eventType: "tool.failed", scopePattern: "*" },
          conditions: [], mapping: { tool: { kind: "pointer", pointer: "/tool" } },
          target: { driverInstanceId: "http-events", resourceChannel: "failures",
            actionKind: "append-only", actionName: "append" }, batchWindowMs: 0 }],
        driverInstances: [{ id: "http-events", driverType: "http", enabled: true,
          config: { baseUrl: `${origin}/events`, privateTargetOrigin: origin } }],
      });
      const offlineRuntime = join(harness.paths.root, "offline-runtime");
      mkdirSync(offlineRuntime);
      runSync(cli, ["event", "codex", "tool.failed", '{"value":{"tool":"shell"}}',
        "session-a", "stable-event-id"], environment(harness, producer.token, offlineRuntime));
      expect(spooled(harness)).toHaveLength(1);
      const spoolDir = join(harness.paths.data, "spool");
      const original = readFileSync(join(spoolDir, spooled(harness)[0]!), "utf8");
      const online = environment(harness, producer.token);

      await Promise.all([runAsync(cli, ["drain"], online), runAsync(cli, ["drain"], online)]);
      await harness.waitFor(async () => invocations === 1 && (await harness.admin.snapshot()).pendingDeliveries === 0 || false);
      expect(spooled(harness)).toHaveLength(0);
      writeFileSync(join(spoolDir, "replayed-after-accepted.json"), original);
      runSync(cli, ["drain"], online);
      expect(spooled(harness)).toHaveLength(0);
      await harness.crash();
      await harness.restart();
      writeFileSync(join(spoolDir, "replayed-after-restart.json"), original);
      runSync(cli, ["drain"], online);
      expect(spooled(harness)).toHaveLength(0);
      expect(invocations).toBe(1);
    } finally {
      await harness.dispose();
      receiver.closeAllConnections();
      await new Promise<void>((resolveClose) => receiver.close(() => resolveClose()));
    }
  }, 30_000);
});

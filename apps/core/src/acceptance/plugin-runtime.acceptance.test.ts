import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, DriverDefinition, SourceDefinition } from "@state-hub/protocol";
import { packPlugin } from "@state-hub/plugin-kit";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

function pluginArchive(
  root: string, id: string, privateKey: string, badHandshake = false, unhealthy = false,
  stopNoticeUrl = "",
): Uint8Array {
  const folder = join(root, id);
  mkdirSync(join(folder, "schemas"), { recursive: true });
  const definition: DriverDefinition = {
    id: `community.${id}.driver`, version: "1.0.0", displayNameKey: `plugin.${id}`,
    configSchema: { type: "object" },
    actions: {
      emit: { kind: "queued-effect", paramsSchema: { type: "object" } },
      show: { kind: "stateful", paramsSchema: { type: "object" } },
    },
  };
  const source: SourceDefinition = {
    id: `community.${id}.source`, version: "1.0.0", displayNameKey: `plugin.${id}.source`,
    configSchema: { type: "object" }, claimSchemas: { status: { type: "object" } }, eventSchemas: {},
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({
    id: `community.${id}`, version: "1.0.0", protocolVersion: "1.0",
    publisher: "runtime-test-publisher", license: "MIT",
    entrypoints: { [process.platform]: "plugin.mjs" },
    driverDefinitions: ["schemas/driver.json"], sourceDefinitions: ["schemas/source.json"],
  }));
  writeFileSync(join(folder, "schemas", "driver.json"), JSON.stringify(definition));
  writeFileSync(join(folder, "schemas", "source.json"), JSON.stringify(source));
  writeFileSync(join(folder, "LICENSE"), "MIT");
  writeFileSync(join(folder, "plugin.mjs"), [
    "const definitions = " + JSON.stringify([definition]) + ";",
    "const sources = " + JSON.stringify([source]) + ";",
    "const stopNoticeUrl = " + JSON.stringify(stopNoticeUrl) + ";",
    "const badHandshake = " + JSON.stringify(badHandshake) + ";",
    "const unhealthy = " + JSON.stringify(unhealthy) + ";",
    "let buffer = Buffer.alloc(0);",
    "function send(id, result) {",
    " const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));",
    " process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));",
    "}",
    "async function handle(request) {",
    " if (request.method === 'statehub.initialize') return { protocolVersion: badHandshake ? '9.9' : '1.0', sourceDefinitions: sources, driverDefinitions: definitions };",
    " if (request.method === 'statehub.health') return { status: unhealthy ? 'failed' : 'ok' };",
    " if (request.method === 'statehub.stop') {",
    "  if (stopNoticeUrl) { await fetch(stopNoticeUrl, { method: 'POST' }); await new Promise((resolve) => setTimeout(resolve, 3000)); }",
    "  return { stopped: true };",
    " }",
    " if (request.method === 'driver.execute') {",
    "  const params = request.params.action?.params ?? {};",
    "  if (params.mode === 'crash') process.exit(42);",
    "  await fetch(request.params.instanceConfig.url, { method: 'POST', headers: { 'x-plugin-pid': String(process.pid) }, body: JSON.stringify({ deliveryId: request.params.deliveryId, actionName: request.params.action?.name }) });",
    "  return { status: 'delivered' };",
    " }",
    " throw new Error('Unknown method');",
    "}",
    "process.stdin.on('data', (chunk) => {",
    " buffer = Buffer.concat([buffer, chunk]);",
    " while (true) {",
    "  const boundary = buffer.indexOf('\\r\\n\\r\\n'); if (boundary < 0) return;",
    "  const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, boundary).toString())?.[1]);",
    "  if (buffer.length < boundary + 4 + length) return;",
    "  const request = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString());",
    "  buffer = buffer.subarray(boundary + 4 + length);",
    "  void handle(request).then((result) => send(request.id, result));",
    " }",
    "});",
    "process.stdin.on('end', () => process.exit(0));",
  ].join("\n"));
  return packPlugin(folder, privateKey);
}

describe("installed plugin subprocesses through the real Core", () => {
  it("keeps another plugin delivering after one exits and rejects incompatible handshakes", async () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-plugin-runtime-acceptance-"));
    const received: Array<{ pid: number; deliveryId: string; actionName: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { deliveryId: string; actionName: string };
      received.push({ pid: Number(request.headers["x-plugin-pid"]), deliveryId: body.deliveryId,
        actionName: body.actionName });
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const harness = await CoreAcceptanceHarness.start();
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init, headers: { authorization: `Bearer ${harness.adminToken}`, ...init.headers },
    });
    const upload = (id: string, badHandshake = false, unhealthy = false) => admin("/api/v1/admin/plugins/install", {
      method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
      body: Buffer.from(pluginArchive(root, id, privateKey, badHandshake, unhealthy)),
    });
    const binding = (id: string, eventType: string, mode: string): Binding => ({
      id, name: id, enabled: true,
      selector: { producerId: "plugin-runtime-test", eventType, scopePattern: "*" },
      conditions: [],
      mapping: { mode: { kind: "constant", value: mode } },
      target: {
        driverInstanceId: id, resourceChannel: id, actionKind: "queued-effect", actionName: "emit",
      },
    });
    try {
      expect((await admin("/api/v1/admin/plugins/trusted-publishers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "runtime-test-publisher", publicKeyPem: publicKey }),
      })).status).toBe(201);
      expect((await upload("alpha")).status).toBe(201);
      expect((await upload("beta")).status).toBe(201);
      const runtime = await (await admin("/api/v1/admin/plugins/runtime")).json() as {
        plugins: Array<{ id: string; status: string; pid?: number; reasonCode?: string }>;
      };
      const alpha = runtime.plugins.find((plugin) => plugin.id === "community.alpha");
      const beta = runtime.plugins.find((plugin) => plugin.id === "community.beta");
      expect(alpha?.status).toBe("running");
      expect(beta?.status).toBe("running");
      expect(alpha?.pid).not.toBe(beta?.pid);
      expect(beta?.pid).not.toBe(harness.processId);

      const stateBinding: Binding = {
        ...binding("beta-state", "unused", "state"),
        selector: { producerId: "plugin-runtime-test", signalId: "status", scopePattern: "*" },
        mapping: { phase: { kind: "pointer", pointer: "/phase" } },
        target: {
          driverInstanceId: "beta", resourceChannel: "beta-state",
          actionKind: "stateful", actionName: "show",
        },
      };
      await harness.admin.publishConfig({
        bindings: [binding("alpha", "plugin.crash", "crash"),
          binding("beta", "plugin.good", "send"), stateBinding],
        driverInstances: ["alpha", "beta"].map((id) => ({
          id, driverType: `community.${id}.driver`, enabled: true, config: { url },
        })),
      });
      const producer = await harness.admin.createProducer("plugin-runtime-test");
      const good = await producer.emitEvent({ eventId: "good-1", type: "plugin.good", value: { n: 1 } });
      expect(good.response.status).toBe(202);
      await harness.waitFor(() => received.length === 1, {
        timeoutMs: 10_000, description: "first plugin HTTP side effect",
      });
      const firstPid = received[0]?.pid;
      expect(firstPid).toBe(beta?.pid);
      const crash = await producer.emitEvent({ eventId: "crash-1", type: "plugin.crash", value: { n: 1 } });
      expect(crash.response.status).toBe(202);
      await harness.waitFor(async () => {
        const status = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtime;
        return status.plugins.find((plugin) => plugin.id === "community.alpha")?.status === "failed";
      }, { description: "one plugin to fail without taking Core down" });
      expect((await harness.fetch("/health/live")).status).toBe(200);

      const again = await producer.emitEvent({ eventId: "good-2", type: "plugin.good", value: { n: 2 } });
      expect(again.response.status).toBe(202);
      await harness.waitFor(() => received.length === 2, { description: "second healthy plugin HTTP side effect" });
      expect(received.map((entry) => entry.pid)).toEqual([firstPid, firstPid]);
      expect(new Set(received.map((entry) => entry.deliveryId)).size).toBe(2);
      const claim = await producer.upsertClaim("session", "status", {
        value: { phase: "active" }, urgency: "informational",
      });
      expect(claim.response.status).toBe(202);
      await harness.waitFor(() => received.length === 3, { description: "initial stateful plugin render" });
      expect(received[2]).toMatchObject({ pid: firstPid, actionName: "show" });

      const disabled = await admin("/api/v1/admin/plugins/community.beta/disable", { method: "POST" });
      expect(disabled.status).toBe(200);
      const disabledCatalog = await (await admin("/api/v1/admin/catalog")).json() as {
        driverDefinitions: Array<{ id: string }>;
      };
      expect(disabledCatalog.driverDefinitions.some((driver) => driver.id === "community.beta.driver")).toBe(false);
      await producer.emitEvent({ eventId: "disabled-1", type: "plugin.good", value: { n: 3 } });
      await harness.waitFor(async () => (await harness.admin.snapshot()).deadLetters >= 2, {
        description: "disabled plugin delivery to settle without network I/O",
      });
      expect(received).toHaveLength(3);
      const enabled = await admin("/api/v1/admin/plugins/community.beta/enable", { method: "POST" });
      expect(enabled.status).toBe(200);
      const enabledBody = await enabled.json() as { runtime: { status: string; pid: number } };
      expect(enabledBody.runtime.status).toBe("running");
      expect(enabledBody.runtime.pid).not.toBe(firstPid);
      await harness.waitFor(() => received.length === 4, {
        description: "current stateful projection replay after plugin re-enable",
      });
      expect(received[3]).toMatchObject({ pid: enabledBody.runtime.pid, actionName: "show" });
      await producer.emitEvent({ eventId: "enabled-1", type: "plugin.good", value: { n: 4 } });
      await harness.waitFor(() => received.length === 5, { description: "re-enabled plugin side effect" });
      expect(received[4]).toMatchObject({ pid: enabledBody.runtime.pid, actionName: "emit" });

      expect((await upload("incompatible", true)).status).toBe(201);
      const withBad = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtime;
      expect(withBad.plugins.find((plugin) => plugin.id === "community.incompatible"))
        .toMatchObject({ status: "failed", reasonCode: "INCOMPATIBLE_HANDSHAKE" });
      expect((await upload("unhealthy", false, true)).status).toBe(201);
      const withUnhealthy = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtime;
      expect(withUnhealthy.plugins.find((plugin) => plugin.id === "community.unhealthy"))
        .toMatchObject({ status: "failed", reasonCode: "PLUGIN_HEALTH_FAILED" });
      expect((await harness.fetch("/health/live")).status).toBe(200);
      await harness.stop();
      expect(readdirSync(join(harness.paths.data, "plugin-runtime"))).toEqual([]);
      await harness.restart();
      const beforeCrash = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtime;
      const priorPids = beforeCrash.plugins.filter((plugin) => plugin.status === "running")
        .map((plugin) => plugin.pid).filter((pid): pid is number => pid !== undefined);
      expect(priorPids).toHaveLength(2);
      await harness.crash();
      await harness.waitFor(() => priorPids.every((pid) => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }), { description: "orphaned plugin processes to exit after Core crash" });
      await harness.restart();
      const recovered = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtime;
      const recoveredPids = recovered.plugins.filter((plugin) => plugin.status === "running")
        .map((plugin) => plugin.pid).filter((pid): pid is number => pid !== undefined);
      expect(recoveredPids).toHaveLength(2);
      expect(recoveredPids.some((pid) => priorPids.includes(pid))).toBe(false);
      expect(readdirSync(join(harness.paths.data, "plugin-runtime"))).toHaveLength(2);
      await harness.stop();
      expect(readdirSync(join(harness.paths.data, "plugin-runtime"))).toEqual([]);
    } finally {
      await harness.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("dependency-aware plugin uninstall through the real Core", () => {
  it("rejects referenced packages, then removes only the unreferenced package and its process", async () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-plugin-uninstall-"));
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const harness = await CoreAcceptanceHarness.start();
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init, headers: { authorization: `Bearer ${harness.adminToken}`, ...init.headers },
    });
    const upload = (id: string) => admin("/api/v1/admin/plugins/install", {
      method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
      body: Buffer.from(pluginArchive(root, id, privateKey)),
    });
    const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    try {
      expect((await admin("/api/v1/admin/plugins/trusted-publishers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "runtime-test-publisher", publicKeyPem: publicKey }),
      })).status).toBe(201);
      expect((await upload("removable")).status).toBe(201);
      expect((await upload("other")).status).toBe(201);
      expect((await harness.fetch("/api/v1/admin/plugins/community.removable/dependencies")).status).toBe(401);
      expect((await harness.fetch("/api/v1/admin/plugins/community.removable",
        { method: "DELETE" })).status).toBe(401);
      const runtimeBefore = await (await admin("/api/v1/admin/plugins/runtime")).json() as {
        plugins: Array<{ id: string; status: string; pid?: number }>;
      };
      const otherPid = runtimeBefore.plugins.find((plugin) => plugin.id === "community.other")?.pid;
      expect(otherPid).toBeTypeOf("number");
      await harness.admin.createProducer("source-producer", "community.removable.source");
      const sensitiveInstance = "device@example.com";
      const sensitiveBinding = "binding@example.com";
      await harness.admin.publishConfig({
        driverInstances: [
          { id: sensitiveInstance, driverType: "community.removable.driver", enabled: true, config: {} },
          { id: "other-instance", driverType: "community.other.driver", enabled: true, config: {} },
        ],
        bindings: [{
          id: sensitiveBinding, name: "remove only after dependencies clear", enabled: true,
          selector: { producerId: "source-producer", eventType: "probe", scopePattern: "*" },
          conditions: [], mapping: {},
          target: { driverInstanceId: sensitiveInstance, resourceChannel: "uninstall",
            actionKind: "queued-effect", actionName: "emit" },
        }],
      });
      const dependencyResponse = await admin("/api/v1/admin/plugins/community.removable/dependencies");
      expect(dependencyResponse.status).toBe(200);
      const dependencies = (await dependencyResponse.json() as {
        dependencies: { driverInstances: string[]; bindings: string[]; producers: string[]; deliveries: string[] };
      }).dependencies;
      expect(dependencies).toEqual({
        driverInstances: [hash(sensitiveInstance)],
        bindings: [hash(sensitiveBinding)],
        producers: [hash("source-producer")],
        deliveries: [],
      });
      const blocked = await admin("/api/v1/admin/plugins/community.removable", { method: "DELETE" });
      expect(blocked.status).toBe(409);
      const blockedBody = await blocked.json() as { error: { code: string; dependencies: typeof dependencies } };
      expect(blockedBody.error.code).toBe("PLUGIN_IN_USE");
      expect(blockedBody.error.dependencies).toEqual(dependencies);
      expect(JSON.stringify(blockedBody)).not.toContain(sensitiveInstance);
      expect(JSON.stringify(blockedBody)).not.toContain(sensitiveBinding);
      expect((await admin("/api/v1/admin/plugins/runtime")).status).toBe(200);
      expect((await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtimeBefore)
        .plugins.find((plugin) => plugin.id === "community.other")?.pid).toBe(otherPid);

      await harness.admin.createProducer("source-producer", "official.custom-http");
      await harness.admin.publishConfig({
        driverInstances: [
          { id: "other-instance", driverType: "community.other.driver", enabled: true, config: {} },
        ],
        bindings: [],
      });
      const clear = await (await admin("/api/v1/admin/plugins/community.removable/dependencies")).json() as {
        dependencies: typeof dependencies;
      };
      expect(clear.dependencies).toEqual({ driverInstances: [], bindings: [], producers: [], deliveries: [] });
      const staleDraftResponse = await admin("/api/v1/admin/config/drafts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driverInstances: [
            { id: sensitiveInstance, driverType: "community.removable.driver", enabled: true, config: {} },
          ],
          bindings: [],
        }),
      });
      expect(staleDraftResponse.status).toBe(201);
      const staleDraft = await staleDraftResponse.json() as { revision: number };
      const removed = await admin("/api/v1/admin/plugins/community.removable", { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ id: "community.removable", removed: true });
      const stalePublish = await admin(`/api/v1/admin/config/drafts/${staleDraft.revision}/publish`,
        { method: "POST" });
      expect(stalePublish.status).toBe(400);
      expect((await stalePublish.json() as { error: { code: string } }).error.code)
        .toBe("UNKNOWN_DRIVER_TYPE");
      const catalog = await (await admin("/api/v1/admin/catalog")).json() as {
        sourceDefinitions: Array<{ id: string }>; driverDefinitions: Array<{ id: string }>;
      };
      expect(catalog.sourceDefinitions.some((entry) => entry.id === "community.removable.source")).toBe(false);
      expect(catalog.driverDefinitions.some((entry) => entry.id === "community.removable.driver")).toBe(false);
      expect(catalog.driverDefinitions.some((entry) => entry.id === "community.other.driver")).toBe(true);
      expect(catalog.driverDefinitions.some((entry) => entry.id === "official.virtual")).toBe(true);
      const runtimeAfter = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtimeBefore;
      expect(runtimeAfter.plugins.some((plugin) => plugin.id === "community.removable")).toBe(false);
      expect(runtimeAfter.plugins.find((plugin) => plugin.id === "community.other"))
        .toMatchObject({ status: "running", pid: otherPid });
      expect((await harness.fetch("/health/live")).status).toBe(200);
      await harness.restart();
      const restarted = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtimeBefore;
      expect(restarted.plugins.map((plugin) => plugin.id)).toEqual(["community.other"]);
      expect(restarted.plugins[0]?.status).toBe("running");
    } finally {
      await harness.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("keeps the installed package after Core crashes between stopping the child and deleting the record", async () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-plugin-uninstall-crash-"));
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    let observedStop: () => void = () => undefined;
    const stopObserved = new Promise<void>((resolve) => { observedStop = resolve; });
    let stopCount = 0;
    const marker = createServer((_request, response) => {
      stopCount += 1;
      observedStop();
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => marker.listen(0, "127.0.0.1", resolve));
    const noticeUrl = `http://127.0.0.1:${(marker.address() as AddressInfo).port}/stopping`;
    const harness = await CoreAcceptanceHarness.start();
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init, headers: { authorization: `Bearer ${harness.adminToken}`, ...init.headers },
    });
    try {
      expect((await admin("/api/v1/admin/plugins/trusted-publishers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "runtime-test-publisher", publicKeyPem: publicKey }),
      })).status).toBe(201);
      expect((await admin("/api/v1/admin/plugins/install", {
        method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(pluginArchive(root, "interrupted", privateKey, false, false, noticeUrl)),
      })).status).toBe(201);
      const pending = admin("/api/v1/admin/plugins/community.interrupted", { method: "DELETE" })
        .catch(() => undefined);
      await stopObserved;
      await harness.crash();
      await pending;
      await harness.restart();
      const installed = await (await admin("/api/v1/admin/plugins")).json() as {
        plugins: Array<{ id: string }>;
      };
      expect(installed.plugins.map((plugin) => plugin.id)).toEqual(["community.interrupted"]);
      const runtime = await (await admin("/api/v1/admin/plugins/runtime")).json() as {
        plugins: Array<{ id: string; status: string }>;
      };
      expect(runtime.plugins[0]).toMatchObject({ id: "community.interrupted", status: "running" });
      expect(readdirSync(join(harness.paths.data, "plugin-runtime"))).toHaveLength(1);
      const racedDelete = admin("/api/v1/admin/plugins/community.interrupted", { method: "DELETE" });
      await harness.waitFor(() => stopCount >= 2, { description: "uninstall to enter plugin stop" });
      await harness.admin.publishConfig({
        driverInstances: [
          { id: "late-instance", driverType: "community.interrupted.driver", enabled: true, config: {} },
        ],
        bindings: [],
      });
      const racedResult = await racedDelete;
      expect(racedResult.status).toBe(409);
      expect((await racedResult.json() as { error: { code: string } }).error.code).toBe("PLUGIN_IN_USE");
      const restored = await (await admin("/api/v1/admin/plugins/runtime")).json() as typeof runtime;
      expect(restored.plugins[0]?.status).toBe("running");
      await harness.admin.publishConfig({ driverInstances: [], bindings: [] });
      const finalDelete = admin("/api/v1/admin/plugins/community.interrupted", { method: "DELETE" });
      await harness.waitFor(() => stopCount >= 3, { description: "final uninstall to enter plugin stop" });
      const racingEnable = admin("/api/v1/admin/plugins/community.interrupted/enable", { method: "POST" });
      const [deleteResult, enableResult] = await Promise.all([finalDelete, racingEnable]);
      expect(deleteResult.status).toBe(200);
      expect(enableResult.status).toBe(404);
      await harness.restart();
      const afterRemoval = await (await admin("/api/v1/admin/plugins")).json() as typeof installed;
      expect(afterRemoval.plugins).toEqual([]);
    } finally {
      await harness.dispose();
      marker.closeAllConnections();
      await new Promise<void>((resolve) => marker.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});

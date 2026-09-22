import { generateKeyPairSync } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, DriverDefinition, SourceDefinition } from "@state-hub/protocol";
import { packPlugin } from "@state-hub/plugin-kit";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

type Gate = "ok" | "schema" | "source" | "migration" | "handshake" | "health" | "result" | "wait" | "slow-stop";

function archive(root: string, key: string, version: string, gate: Gate, controlUrl: string): Uint8Array {
  const folder = join(root, `package-${version}-${gate}`);
  mkdirSync(join(folder, "schemas"), { recursive: true });
  const driver: DriverDefinition = {
    id: "community.upgrade.driver", version, displayNameKey: "upgrade.driver",
    configSchema: gate === "schema" ? { type: "object", required: ["impossible"] } :
      version === "1.0.0" ? { type: "object", required: ["url"] } :
        { type: "object", required: ["url", "generation"], properties: {
          url: { type: "string" }, generation: { type: "integer", const: 2 },
        } },
    actions: { emit: { kind: "queued-effect", paramsSchema: { type: "object" } } },
  };
  const source: SourceDefinition = {
    id: "community.upgrade.source", version, displayNameKey: "upgrade.source",
    configSchema: { type: "object" }, claimSchemas: { status: gate === "source" ?
      { type: "object", required: ["phase"] } : { type: "object" } },
    eventSchemas: { "upgrade.emit": { type: "object" } },
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({
    id: "community.upgrade", version, protocolVersion: "1.0",
    publisher: "upgrade-test-publisher", license: "MIT",
    entrypoints: { [process.platform]: "plugin.mjs" },
    driverDefinitions: ["schemas/driver.json"], sourceDefinitions: ["schemas/source.json"],
  }));
  writeFileSync(join(folder, "schemas", "driver.json"), JSON.stringify(driver));
  writeFileSync(join(folder, "schemas", "source.json"), JSON.stringify(source));
  writeFileSync(join(folder, "LICENSE"), "MIT");
  writeFileSync(join(folder, "plugin.mjs"), [
    `const drivers = ${JSON.stringify([driver])};`,
    `const sources = ${JSON.stringify([source])};`,
    `const gate = ${JSON.stringify(gate)};`,
    `const controlUrl = ${JSON.stringify(controlUrl)};`,
    "let buffer = Buffer.alloc(0);",
    "function send(id, result) { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body])); }",
    "async function handle(request) {",
    " if (request.method === 'statehub.initialize') return { protocolVersion: gate === 'handshake' ? '9.9' : '1.0', sourceDefinitions: sources, driverDefinitions: drivers };",
    " if (request.method === 'statehub.health') return { status: gate === 'health' ? 'failed' : 'ok' };",
    " if (request.method === 'statehub.stop') { if (gate === 'slow-stop') await new Promise((resolve) => setTimeout(resolve, 3000)); return { stopped: true }; }",
    " if (request.method === 'statehub.migrate') {",
    "  if (gate === 'migration') throw new Error('credential: test-secret');",
    "  if (gate === 'wait') await fetch(controlUrl + '/gate', { method: 'POST' });",
    "  if (gate === 'result') return { driverInstances: [{ id: 'wrong', config: {} }] };",
    "  return { driverInstances: request.params.driverInstances.map((item) => ({ id: item.id, config: { ...item.config, generation: 2 } })) };",
    " }",
    " if (request.method === 'driver.execute') {",
    "  await fetch(request.params.instanceConfig.url + '/execute', { method: 'POST', headers: { 'x-plugin-pid': String(process.pid) }, body: JSON.stringify({ generation: request.params.instanceConfig.generation ?? 1 }) });",
    "  return { status: 'delivered' };",
    " }",
    " throw new Error('Unknown method');",
    "}",
    "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const boundary = buffer.indexOf('\\r\\n\\r\\n'); if (boundary < 0) return; const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, boundary).toString())?.[1]); if (buffer.length < boundary + 4 + length) return; const request = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString()); buffer = buffer.subarray(boundary + 4 + length); void handle(request).then((result) => send(request.id, result)).catch(() => process.exit(51)); } });",
    "process.stdin.on('end', () => process.exit(0));",
  ].join("\n"));
  return packPlugin(folder, key);
}

const binding: Binding = {
  id: "upgrade-binding", name: "upgrade", enabled: true,
  selector: { producerId: "upgrade-producer", sourceType: "community.upgrade.source",
    eventType: "upgrade.emit", scopePattern: "*" },
  conditions: [], mapping: {},
  target: { driverInstanceId: "upgrade-target", resourceChannel: "upgrade",
    actionKind: "queued-effect", actionName: "emit" },
};

describe("side-by-side plugin upgrade through the real Core", () => {
  it("keeps the old process serving during preflight, fences failed gates, and activates migrated config", async () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-upgrade-"));
    const received: Array<{ pid: number; generation: number }> = [];
    let gateResponse: ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      if (request.url === "/gate") { gateResponse = response; return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ pid: Number(request.headers["x-plugin-pid"]),
        generation: (JSON.parse(Buffer.concat(chunks).toString()) as { generation: number }).generation });
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const harness = await CoreAcceptanceHarness.start();
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init, headers: { authorization: `Bearer ${harness.adminToken}`, ...init.headers },
    });
    const upgrade = (gate: Gate, bytes = archive(root, privateKey, "2.0.0", gate, url)) =>
      admin("/api/v1/admin/plugins/community.upgrade/upgrade", {
        method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(bytes),
      });
    try {
      expect((await admin("/api/v1/admin/plugins/trusted-publishers", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "upgrade-test-publisher", publicKeyPem: publicKey }) })).status).toBe(201);
      expect((await admin("/api/v1/admin/plugins/install", { method: "POST",
        headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(archive(root, privateKey, "1.0.0", "slow-stop", url)) })).status).toBe(201);
      await harness.admin.publishConfig({ bindings: [binding], driverInstances: [{
        id: "upgrade-target", driverType: "community.upgrade.driver", enabled: true, config: { url },
      }] });
      const producer = await harness.admin.createProducer("upgrade-producer", "community.upgrade.source");
      const emit = async (eventId: string) => {
        const result = await producer.emitEvent({ eventId, type: "upgrade.emit", sourceType: "community.upgrade.source", value: {} });
        expect(result.response.status).toBe(202);
        await harness.waitFor(() => received.length >= Number(eventId.split("-")[1]),
          { description: `plugin side effect ${eventId}` });
      };
      expect((await producer.upsertClaim("default", "status", { value: {}, urgency: "informational" }))
        .response.status).toBe(202);
      await emit("event-1");
      const oldPid = received[0]!.pid;
      const failed: Array<[Gate, string]> = [
        ["schema", "PLUGIN_SCHEMA_INCOMPATIBLE"], ["source", "PLUGIN_SOURCE_INCOMPATIBLE"],
        ["migration", "PLUGIN_MIGRATION_FAILED"],
        ["handshake", "INCOMPATIBLE_HANDSHAKE"], ["health", "PLUGIN_HEALTH_FAILED"],
        ["result", "PLUGIN_MIGRATION_RESULT"],
      ];
      const corrupt = Buffer.from("invalid plugin archive");
      expect((await upgrade("ok", corrupt)).status).toBe(400);
      expect(await (await admin("/api/v1/admin/plugins/community.upgrade/upgrade-status")).json())
        .toMatchObject({ status: "failed", reasonCode: "INVALID_PLUGIN_PACKAGE" });
      for (const [gate, code] of failed) {
        const response = await upgrade(gate);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code } });
        expect(await (await admin("/api/v1/admin/plugins/community.upgrade/upgrade-status")).json())
          .toMatchObject({ status: "failed", reasonCode: code });
        const installed = await (await admin("/api/v1/admin/plugins")).json() as {
          plugins: Array<{ version: string }> };
        expect(installed.plugins[0]?.version).toBe("1.0.0");
        const config = await (await admin("/api/v1/admin/config/export")).json() as {
          config: { bindings: Binding[]; driverInstances: Array<{ config: object }> } };
        expect(config.config.bindings).toEqual([binding]);
        expect(config.config.driverInstances[0]?.config).toEqual({ url });
      }
      const waiting = upgrade("wait");
      await harness.waitFor(() => Boolean(gateResponse), { description: "candidate migration gate" });
      await emit("event-2");
      expect(received[1]?.pid).toBe(oldPid);
      gateResponse!.writeHead(204).end();
      const success = await waiting;
      expect(success.status).toBe(200);
      expect(await success.json()).toMatchObject({ version: "2.0.0", status: "active" });
      expect(await (await admin("/api/v1/admin/plugins/community.upgrade/upgrade-status")).json())
        .toMatchObject({ status: "active" });
      await emit("event-3");
      expect(received[2]).toMatchObject({ generation: 2 });
      expect(received[2]?.pid).not.toBe(oldPid);
      const runtime = await (await admin("/api/v1/admin/plugins/runtime")).json() as {
        plugins: Array<{ id: string; status: string; pid?: number }> };
      expect(runtime.plugins.find((item) => item.id === "community.upgrade"))
        .toMatchObject({ status: "running", pid: received[2]?.pid });
      await harness.restart();
      await emit("event-4");
      expect(received[3]).toMatchObject({ generation: 2 });
    } finally {
      if (gateResponse && !gateResponse.headersSent) gateResponse.writeHead(204).end();
      await harness.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
  it("recovers the committed active version and migrated revision after Core exits at the switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-upgrade-crash-"));
    const received: number[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push((JSON.parse(Buffer.concat(chunks).toString()) as { generation: number }).generation);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const harness = await CoreAcceptanceHarness.start({ upgradeCrashAfterCommit: true });
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init, headers: { authorization: `Bearer ${harness.adminToken}`, ...init.headers },
    });
    try {
      expect((await admin("/api/v1/admin/plugins/trusted-publishers", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "upgrade-test-publisher", publicKeyPem: publicKey }) })).status).toBe(201);
      expect((await admin("/api/v1/admin/plugins/install", { method: "POST",
        headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(archive(root, privateKey, "1.0.0", "ok", url)) })).status).toBe(201);
      await harness.admin.publishConfig({ bindings: [binding], driverInstances: [{
        id: "upgrade-target", driverType: "community.upgrade.driver", enabled: true, config: { url },
      }] });
      const producer = await harness.admin.createProducer("upgrade-producer", "community.upgrade.source");
      await admin("/api/v1/admin/plugins/community.upgrade/upgrade", {
        method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(archive(root, privateKey, "2.0.0", "ok", url)),
      }).catch(() => undefined);
      await harness.waitFor(() => !harness.isRunning, {
        description: "Core crash immediately after upgrade transaction",
      });
      await harness.restart();
      const installed = await (await admin("/api/v1/admin/plugins")).json() as {
        plugins: Array<{ version: string }> };
      expect(installed.plugins).toHaveLength(1);
      expect(installed.plugins[0]?.version).toBe("2.0.0");
      expect(await (await admin("/api/v1/admin/plugins/community.upgrade/upgrade-status")).json())
        .toMatchObject({ status: "active" });
      const exported = await (await admin("/api/v1/admin/config/export")).json() as {
        config: { bindings: Binding[]; driverInstances: Array<{ config: object }> } };
      expect(exported.config.bindings).toEqual([binding]);
      expect(exported.config.driverInstances[0]?.config).toEqual({ url, generation: 2 });
      const result = await producer.emitEvent({ eventId: "after-crash", type: "upgrade.emit",
        sourceType: "community.upgrade.source", value: {} });
      expect(result.response.status).toBe(202);
      await harness.waitFor(() => received.length === 1, {
        description: "one post-recovery plugin HTTP side effect",
      });
      expect(received).toEqual([2]);
    } finally {
      await harness.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

});

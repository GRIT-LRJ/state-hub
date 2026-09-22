import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { packPlugin } from "@state-hub/plugin-kit";
import type { Binding, DriverDefinition } from "@state-hub/protocol";
import { resourceKey } from "@state-hub/domain";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const separator = String.fromCharCode(31);

describe("resource and batch identity integration", () => {
  it("keeps two old-colliding resources as separate projections and driver calls", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("resource-identity");
      const firstInstance = ["virtual", "left"].join(separator);
      const secondInstance = "virtual";
      const firstChannel = "right";
      const secondChannel = ["left", "right"].join(separator);
      const makeBinding = (id: string, signalId: string, driverInstanceId: string, resourceChannel: string): Binding => ({
        id,
        name: id,
        enabled: true,
        selector: { producerId: "resource-identity", signalId, scopePattern: "*" },
        conditions: [],
        mapping: { phase: { kind: "pointer", pointer: "/phase" } },
        target: { driverInstanceId, resourceChannel, actionKind: "stateful", actionName: "render" },
      });
      await harness.admin.publishConfig({
        bindings: [
          makeBinding("first", "first", firstInstance, firstChannel),
          makeBinding("second", "second", secondInstance, secondChannel),
        ],
        driverInstances: [
          { id: firstInstance, driverType: "virtual", enabled: true, config: {} },
          { id: secondInstance, driverType: "virtual", enabled: true, config: {} },
        ],
      });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0);
      const events = await harness.observeEvents();
      const result = await producer.replaceSnapshot([
        { scopeId: "scope", signalId: "first", value: { phase: "first" } },
        { scopeId: "scope", signalId: "second", value: { phase: "second" } },
      ]);
      expect(result.response.status).toBe(202);
      const snapshot = await harness.admin.snapshot();
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceKey: resourceKey(firstInstance, firstChannel),
        driverInstanceId: firstInstance,
        resourceChannel: firstChannel,
        action: { name: "render", params: { phase: "first" } },
      }));
      expect(snapshot.projections).toContainEqual(expect.objectContaining({
        resourceKey: resourceKey(secondInstance, secondChannel),
        driverInstanceId: secondInstance,
        resourceChannel: secondChannel,
        action: { name: "render", params: { phase: "second" } },
      }));
      const renderOne = await events.waitFor("virtual.rendered");
      const renderTwo = await events.waitFor("virtual.rendered");
      expect(new Set([renderOne, renderTwo].map((event) => {
        const data = event.data as { action?: { params?: { phase?: string } } };
        return data.action?.params?.phase;
      }))).toEqual(new Set(["first", "second"]));
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  it("does not merge valid plugin actions whose old batch keys collided", async () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-batch-identity-"));
    const received: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { actionName: string }).actionName);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/probe";
    const harness = await CoreAcceptanceHarness.start();
    try {
      const firstId = ["a", "b"].join(separator);
      const secondAction = ["b", "c"].join(separator);
      const definition: DriverDefinition = {
        id: "community.batch-identity.driver", version: "1.0.0", displayNameKey: "batch.identity",
        configSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
        actions: {
          c: { kind: "append-only", paramsSchema: { type: "object" } },
          [secondAction]: { kind: "append-only", paramsSchema: { type: "object" } },
        },
      };
      mkdirSync(join(root, "schemas"));
      writeFileSync(join(root, "LICENSE"), "MIT");
      writeFileSync(join(root, "schemas", "driver.json"), JSON.stringify(definition));
      writeFileSync(join(root, "manifest.json"), JSON.stringify({
        id: "community.batch-identity", version: "1.0.0", protocolVersion: "1.0",
        publisher: "batch-identity-publisher", license: "MIT",
        entrypoints: { [process.platform]: "plugin.mjs" }, driverDefinitions: ["schemas/driver.json"],
      }));
      writeFileSync(join(root, "plugin.mjs"),
        "import { runPlugin } from " + JSON.stringify(pathToFileURL(join(process.cwd(), "..", "..", "packages", "sdk", "dist", "index.js")).href) + ";\n" +
        "const definition = " + JSON.stringify(definition) + ";\n" +
        "runPlugin({ driverDefinitions: [definition], executeDriverAction: async (request) => {" +
        " await fetch(request.instanceConfig.url, { method: 'POST'," +
        " body: JSON.stringify({ actionName: request.action?.name ?? request.batch?.[0]?.action?.name }) });" +
        " return { status: 'delivered' }; } });\n");
      const keys = generateKeyPairSync("ed25519");
      const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
        ...init, headers: { authorization: "Bearer " + harness.adminToken, ...init.headers },
      });
      expect((await admin("/api/v1/admin/plugins/trusted-publishers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "batch-identity-publisher", publicKeyPem }),
      })).status).toBe(201);
      expect((await admin("/api/v1/admin/plugins/install", {
        method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(packPlugin(root, privateKeyPem)),
      })).status).toBe(201);
      const producer = await harness.admin.createProducer("batch-identity");
      const makeBinding = (id: string, eventType: string, actionName: string): Binding => ({
        id, name: id, enabled: true,
        selector: { producerId: "batch-identity", eventType, scopePattern: "*" },
        conditions: [],
        mapping: { sequence: { kind: "pointer", pointer: "/sequence" } },
        target: {
          driverInstanceId: "batch-driver", resourceChannel: "audit",
          actionKind: "append-only", actionName,
        },
        batchWindowMs: 1_000,
      });
      await harness.admin.publishConfig({
        bindings: [makeBinding(firstId, "event.first", "c"), makeBinding("a", "event.second", secondAction)],
        driverInstances: [{ id: "batch-driver", driverType: definition.id, enabled: true, config: { url } }],
      });
      expect((await producer.emitEvent({ eventId: "first", type: "event.first", value: { sequence: 1 } })).response.status)
        .toBe(202);
      expect((await producer.emitEvent({ eventId: "second", type: "event.second", value: { sequence: 2 } })).response.status)
        .toBe(202);
      await harness.waitFor(() => received.length === 2, {
        timeoutMs: 10_000, description: "two separate plugin driver calls",
      });
      expect(new Set(received)).toEqual(new Set(["c", secondAction]));
    } finally {
      await harness.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

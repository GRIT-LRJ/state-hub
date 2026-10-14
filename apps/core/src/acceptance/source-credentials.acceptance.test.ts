import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { AsyncEntry } from "@napi-rs/keyring";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

describe("source and credential management through the real Core", () => {
  it("rejects concurrent create-only requests without rotating the winning token", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const create = () => harness.fetch("/api/v1/admin/producers", {
        method: "POST", headers: { authorization: `Bearer ${harness.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ producerId: "create-only-source", sourceDefinitionId: "official.custom-http", createOnly: true }),
      });
      const responses = await Promise.all([create(), create()]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const winner = await responses.find((response) => response.status === 201)!.json() as { token: string };
      const rejected = await responses.find((response) => response.status === 409)!.json();
      expect(rejected).toMatchObject({ error: { code: "PRODUCER_EXISTS" } });
      const authorized = await harness.fetch("/api/v1/producers/create-only-source/commands/absent", {
        headers: { authorization: `Bearer ${winner.token}` },
      });
      expect(authorized.status).toBe(404);
    } finally { await harness.dispose(); }
  }, 20_000);

  it.skipIf(process.platform !== "win32")("delivers with a real OS credential and never persists its value", async () => {
    const reference = `pushplus:acceptance:${process.pid}`;
    const secret = "disposable-acceptance-secret";
    const entry = new AsyncEntry("dev.statehub.desktop", reference);
    const requests: Array<Record<string, unknown>> = [];
    const target = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" }).end('{"code":200,"data":"accepted"}');
    });
    await entry.setPassword(secret);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("credential-source", "official.custom-http");
      await harness.admin.publishConfig({
        bindings: [{
          id: "credential-binding", name: "Credential delivery", enabled: true,
          selector: { producerId: "credential-source", eventType: "custom", scopePattern: "*" },
          conditions: [], mapping: { content: { kind: "pointer", pointer: "/content" } },
          target: { driverInstanceId: "credential-pushplus", resourceChannel: "messages",
            actionKind: "append-only", actionName: "send" },
        }],
        driverInstances: [{ id: "credential-pushplus", driverType: "pushplus", enabled: true,
          config: { tokenSecretRef: reference, endpoint: `${origin}/send`, privateTargetOrigin: origin } }],
      });
      const sent = await producer.emitEvent({ eventId: "credential-delivery",
        type: "custom", value: { content: "hello" } });
      expect(sent.response.status).toBe(202);
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0 && requests.length === 1);
      expect(requests).toEqual([expect.objectContaining({ token: secret, content: "hello" })]);
      const exported = await harness.fetch("/api/v1/admin/config/export", {
        headers: { authorization: `Bearer ${harness.adminToken}` },
      });
      expect(await exported.text()).not.toContain(secret);
      const database = new Database(harness.paths.database, { readonly: true, fileMustExist: true });
      try {
        expect(database.prepare("SELECT count(*) AS n FROM deliveries WHERE status = 'delivered'")
          .get()).toMatchObject({ n: 1 });
        const row = database.prepare("SELECT config_json FROM config_revisions WHERE status = 'published'")
          .get() as { config_json: string };
        expect(row.config_json).not.toContain(secret);
      } finally { database.close(); }
      expect(JSON.stringify(await harness.admin.diagnostics())).not.toContain(secret);
    } finally {
      await harness.dispose();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await entry.deleteCredential();
    }
  }, 20_000);

  it("lists source-bound producers without tokens and revokes rotated tokens", async () => {
    const harness = await CoreAcceptanceHarness.start();
    try {
      const first = await harness.admin.createProducer("managed-source", "official.custom-http");
      const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
        ...init, headers: { authorization: `Bearer ${harness.adminToken}` },
      });
      const list = await admin("/api/v1/admin/producers");
      expect(list.status).toBe(200);
      const body = await list.json() as { producers: Array<Record<string, unknown>> };
      expect(body.producers).toContainEqual(expect.objectContaining({
        producerId: "managed-source", sourceDefinitionId: "official.custom-http", revokedAt: null,
      }));
      expect(JSON.stringify(body)).not.toContain(first.token);

      const rotated = await harness.admin.createProducer("managed-source", "official.custom-http");
      const route = "/api/v1/producers/managed-source/commands/absent";
      expect((await first.fetch(route)).status).toBe(401);
      expect((await rotated.fetch(route)).status).toBe(404);
      expect((await admin("/api/v1/admin/producers/managed-source/revoke", { method: "POST" })).status).toBe(204);
      expect((await rotated.fetch(route)).status).toBe(401);

      const database = new Database(harness.paths.database, { readonly: true, fileMustExist: true });
      try {
        const row = database.prepare("SELECT token_hash, source_definition_id, revoked_at FROM producer_tokens WHERE producer_id = ?")
          .get("managed-source") as { token_hash: string; source_definition_id: string; revoked_at: string };
        expect(row.token_hash).not.toBe(first.token);
        expect(row.token_hash).not.toBe(rotated.token);
        expect(row.source_definition_id).toBe("official.custom-http");
        expect(row.revoked_at).not.toBeNull();
      } finally { database.close(); }
    } finally { await harness.dispose(); }
  }, 20_000);

  it("keeps a missing PushPlus credential out of HTTP, SQLite and support output", async () => {
    let invocations = 0;
    const target = createServer(async (request, response) => {
      invocations += 1;
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const harness = await CoreAcceptanceHarness.start();
    try {
      const producer = await harness.admin.createProducer("pushplus-source", "official.custom-http");
      const binding: Binding = {
        id: "pushplus-binding", name: "PushPlus message", enabled: true,
        selector: { producerId: "pushplus-source", eventType: "custom", scopePattern: "*" },
        conditions: [], mapping: { content: { kind: "pointer", pointer: "/content" } },
        target: { driverInstanceId: "pushplus-main", resourceChannel: "messages",
          actionKind: "append-only", actionName: "send" },
      };
      await harness.admin.publishConfig({
        bindings: [binding],
        driverInstances: [{ id: "pushplus-main", driverType: "pushplus", enabled: true,
          config: { tokenSecretRef: "pushplus:unavailable", endpoint: `${origin}/send`,
            privateTargetOrigin: origin } }],
      });
      const sent = await producer.emitEvent({ eventId: "missing-keyring-secret",
        type: "custom", value: { content: "user-controlled-private-text" } });
      expect(sent.response.status).toBe(202);
      await harness.waitFor(async () => (await harness.admin.snapshot()).deadLetters === 1 || false);
      expect(invocations).toBe(0);

      const exported = await harness.fetch("/api/v1/admin/config/export", {
        headers: { authorization: `Bearer ${harness.adminToken}` },
      });
      expect((await exported.text())).toContain("pushplus:unavailable");
      const database = new Database(harness.paths.database, { readonly: true, fileMustExist: true });
      try {
        const config = database.prepare("SELECT config_json FROM config_revisions WHERE status = 'published'")
          .get() as { config_json: string };
        expect(config.config_json).toContain("pushplus:unavailable");
        expect(config.config_json).not.toContain("user-controlled-private-text");
      } finally { database.close(); }
      const bundle = JSON.stringify(await harness.admin.diagnostics());
      expect(bundle).not.toContain("user-controlled-private-text");
      expect(bundle).not.toContain("pushplus:unavailable");
    } finally {
      await harness.dispose();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  }, 20_000);
});

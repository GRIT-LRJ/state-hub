import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { packPlugin } from "@state-hub/plugin-kit";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";
import { StateHubDatabase } from "../database.js";
import { PluginRepository } from "../plugin-repository.js";
import { HubEventBus } from "../events.js";
import { StateHubService } from "../service.js";
import { validateClaimValue } from "../schema-validation.js";

function fixture(claimSchema: Record<string, unknown> = {
  type: "object", required: ["phase"], properties: { phase: { const: "ready" } },
}): { root: string; archive: Uint8Array; publicKeyPem: string; privateKeyPem: string } {
  const root = mkdtempSync(join(tmpdir(), "statehub-plugin-acceptance-"));
  mkdirSync(join(root, "schemas"));
  writeFileSync(join(root, "LICENSE"), "MIT");
  writeFileSync(join(root, "plugin.js"), "process.exit(0)");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    id: "community.sample", version: "1.0.0", protocolVersion: "1.0", publisher: "sample-publisher",
    license: "MIT", entrypoints: { [process.platform]: "plugin.js" },
    sourceDefinitions: ["schemas/source.json"], driverDefinitions: ["schemas/driver.json"],
  }));
  writeFileSync(join(root, "schemas", "source.json"), JSON.stringify({
    id: "community.sample.source", version: "1.0.0", displayNameKey: "sample.source",
    configSchema: { type: "object" }, claimSchemas: { status: claimSchema }, eventSchemas: {},
  }));
  writeFileSync(join(root, "schemas", "driver.json"), JSON.stringify({
    id: "community.sample.driver", version: "1.0.0", displayNameKey: "sample.driver",
    configSchema: { type: "object" }, actions: {
      notify: { kind: "append-only", paramsSchema: { type: "object" } },
    },
  }));
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    root,
    archive: packPlugin(root, privateKeyPem),
    privateKeyPem,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("plugin installation through the real Core management API", () => {
  it("persists trusted signed definitions, validates producer values, and leaves no partial failed install", async () => {
    const plugin = fixture();
    const harness = await CoreAcceptanceHarness.start();
    const admin = (path: string, init: RequestInit = {}) => harness.fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${harness.adminToken}`, ...init.headers },
    });
    const upload = (archive: Uint8Array) => admin("/api/v1/admin/plugins/install", {
      method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" }, body: Buffer.from(archive),
    });
    try {
      expect((await harness.fetch("/api/v1/admin/plugins/install", {
        method: "POST", headers: { "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(plugin.archive),
      })).status).toBe(401);
      expect((await upload(plugin.archive)).status).toBe(400);
      let catalog = await (await admin("/api/v1/admin/catalog")).json() as {
        sourceDefinitions: Array<{ id: string }>;
        driverDefinitions: Array<{ id: string; actions: Record<string, unknown> }>;
      };
      expect(catalog.sourceDefinitions.some((source) => source.id === "community.sample.source")).toBe(false);
      const trust = await admin("/api/v1/admin/plugins/trusted-publishers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "sample-publisher", publicKeyPem: plugin.publicKeyPem }),
      });
      expect(trust.status).toBe(201);
      expect((await upload(plugin.archive)).status).toBe(201);

      catalog = await (await admin("/api/v1/admin/catalog")).json() as typeof catalog;
      expect(catalog.sourceDefinitions.some((source) => source.id === "community.sample.source")).toBe(true);
      expect(catalog.driverDefinitions.find((driver) => driver.id === "community.sample.driver")?.actions)
        .toMatchObject({ notify: { kind: "append-only" } });
      const producer = await harness.admin.createProducer("plugin-producer", "community.sample.source");
      const valid = await producer.upsertClaim("scope", "status", { value: { phase: "ready" } });
      expect(valid.response.status).toBe(202);
      const invalid = await producer.fetch("/api/v1/producers/plugin-producer/scopes/scope/claims/status", {
        method: "PUT", body: JSON.stringify({ value: { phase: "wrong" } }),
      });
      expect(invalid.status).toBe(422);

      const changed = unzipSync(plugin.archive);
      changed["plugin.js"] = Buffer.from("tampered");
      expect((await upload(zipSync(changed))).status).toBe(400);
      writeFileSync(join(plugin.root, "manifest.json"), JSON.stringify({
        id: "community.sample", version: "1.0.1", protocolVersion: "1.0",
        publisher: "sample-publisher", license: "MIT",
        entrypoints: { [process.platform === "win32" ? "linux" : "win32"]: "plugin.js" },
        sourceDefinitions: ["schemas/source.json"], driverDefinitions: ["schemas/driver.json"],
      }));
      expect((await upload(packPlugin(plugin.root, plugin.privateKeyPem))).status).toBe(400);
      const database = new Database(harness.paths.database, { readonly: true });
      try {
        expect((database.prepare("SELECT count(*) AS count FROM plugin_packages").get() as { count: number }).count).toBe(1);
      } finally { database.close(); }
      const installed = await (await admin("/api/v1/admin/plugins")).json() as { plugins: unknown[] };
      expect(installed.plugins).toHaveLength(1);
      expect(JSON.stringify(installed)).not.toContain(plugin.privateKeyPem);
      expect(JSON.stringify(installed)).not.toContain(harness.adminToken);

      await harness.restart();
      catalog = await (await admin("/api/v1/admin/catalog")).json() as typeof catalog;
      expect(catalog.sourceDefinitions.some((source) => source.id === "community.sample.source")).toBe(true);
    } finally {
      await harness.dispose();
      rmSync(plugin.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts unsigned packages only in explicitly enabled development mode and rejects invalid schema", async () => {
    const plugin = fixture();
    const files = unzipSync(plugin.archive);
    delete files["signature.json"];
    const unsigned = zipSync(files);
    const production = await CoreAcceptanceHarness.start();
    const development = await CoreAcceptanceHarness.start({ pluginDevelopmentMode: true });
    const upload = (harness: CoreAcceptanceHarness, archive: Uint8Array) => harness.fetch(
      "/api/v1/admin/plugins/install", {
        method: "POST",
        headers: { authorization: `Bearer ${harness.adminToken}`, "content-type": "application/vnd.statehub.plugin" },
        body: Buffer.from(archive),
      },
    );
    try {
      expect((await upload(production, unsigned)).status).toBe(400);
      expect((await upload(development, unsigned)).status).toBe(201);
      const developer = await development.admin.createProducer("development-producer", "community.sample.source");
      expect((await developer.upsertClaim("scope", "status", { value: { phase: "ready" } })).response.status).toBe(202);
      expect((await developer.fetch("/api/v1/producers/development-producer/scopes/scope/claims/status", {
        method: "PUT", body: JSON.stringify({ value: { phase: "wrong" } }),
      })).status).toBe(422);
      await development.stop();
      const reopened = new StateHubDatabase(development.paths.database);
      try {
        const productionPolicy = new PluginRepository(reopened, false);
        expect(productionPolicy.catalog().sourceDefinitions.some((source) => source.id === "community.sample.source")).toBe(false);
        expect(validateClaimValue(reopened, "development-producer", "status", { phase: "ready" }, productionPolicy))
          .toMatch(/not declared/u);
        const productionService = new StateHubService(reopened, new HubEventBus(), productionPolicy);
        expect(() => productionService.createConfigDraft({
          bindings: [],
          driverInstances: [{
            id: "development-driver", driverType: "community.sample.driver", enabled: true, config: {},
          }],
        })).toThrow("Driver type is not installed");
      } finally { reopened.close(); }
      const invalid = fixture({ type: "not-a-json-schema-type" });
      try {
        const trust = await production.fetch("/api/v1/admin/plugins/trusted-publishers", {
          method: "POST", headers: { authorization: `Bearer ${production.adminToken}`, "content-type": "application/json" },
          body: JSON.stringify({ id: "sample-publisher", publicKeyPem: invalid.publicKeyPem }),
        });
        expect(trust.status).toBe(201);
        expect((await upload(production, invalid.archive)).status).toBe(400);
        const database = new Database(production.paths.database, { readonly: true });
        try {
          expect((database.prepare("SELECT count(*) AS count FROM plugin_packages").get() as { count: number }).count).toBe(0);
        } finally { database.close(); }
      } finally { rmSync(invalid.root, { recursive: true, force: true }); }
    } finally {
      await production.dispose();
      await development.dispose();
      rmSync(plugin.root, { recursive: true, force: true });
    }
  }, 30_000);
});

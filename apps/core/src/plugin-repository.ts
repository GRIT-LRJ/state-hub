import { createHash, createPublicKey } from "node:crypto";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { verifyPlugin } from "@state-hub/plugin-kit";
import type { DriverDefinition, SourceDefinition } from "@state-hub/protocol";
import { builtinCatalog } from "./builtins.js";
import type { StateHubDatabase } from "./database.js";

type Catalog = { sourceDefinitions: SourceDefinition[]; driverDefinitions: DriverDefinition[] };
interface PackageRow {
  id: string;
  version: string;
  publisher_id: string;
  signed: number;
  archive_sha256: string;
  installed_at: string;
  source_definitions_json: string;
  driver_definitions_json: string;
}

export class PluginInstallError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDefinition(bytes: Uint8Array, kind: "source" | "driver"): SourceDefinition | DriverDefinition {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!isRecord(value) || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.id) ||
    typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value.version) ||
    typeof value.displayNameKey !== "string" || !value.displayNameKey || !isRecord(value.configSchema)) {
    throw new PluginInstallError("INVALID_PLUGIN_DEFINITION", "Plugin definition is invalid");
  }
  if (kind === "source") {
    if (!isRecord(value.claimSchemas) || !isRecord(value.eventSchemas)) {
      throw new PluginInstallError("INVALID_PLUGIN_DEFINITION", "Plugin source definition is invalid");
    }
    for (const schema of [...Object.values(value.claimSchemas), ...Object.values(value.eventSchemas)]) {
      if (!isRecord(schema)) throw new PluginInstallError("INVALID_PLUGIN_DEFINITION", "Plugin source schema is invalid");
    }
    return value as unknown as SourceDefinition;
  }
  if (!isRecord(value.actions)) throw new PluginInstallError("INVALID_PLUGIN_DEFINITION", "Plugin driver definition is invalid");
  for (const action of Object.values(value.actions)) {
    if (!isRecord(action) || !["stateful", "queued-effect", "append-only"].includes(String(action.kind)) ||
      !isRecord(action.paramsSchema)) {
      throw new PluginInstallError("INVALID_PLUGIN_DEFINITION", "Plugin action contract is invalid");
    }
  }
  return value as unknown as DriverDefinition;
}

function validateSchemas(sourceDefinitions: SourceDefinition[], driverDefinitions: DriverDefinition[]): void {
  const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (
    options: object,
  ) => { compile(schema: object): unknown };
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
    instance: { compile(schema: object): unknown },
  ) => void;
  const compile = (schema: object): void => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    ajv.compile(schema);
  };
  try {
    for (const source of sourceDefinitions) {
      compile(source.configSchema);
      for (const schema of [...Object.values(source.claimSchemas), ...Object.values(source.eventSchemas)]) compile(schema);
    }
    for (const driver of driverDefinitions) {
      compile(driver.configSchema);
      for (const action of Object.values(driver.actions)) compile(action.paramsSchema);
    }
  } catch {
    throw new PluginInstallError("INVALID_PLUGIN_SCHEMA", "Plugin JSON Schema is invalid");
  }
}

export class PluginRepository {
  constructor(private readonly db: StateHubDatabase, private readonly developmentMode = false) {}

  trustPublisher(id: string, publicKeyPem: string): { id: string; fingerprint: string } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || publicKeyPem.length > 8192) {
      throw new PluginInstallError("INVALID_PUBLISHER", "Publisher identity or public key is invalid");
    }
    let key;
    try { key = createPublicKey(publicKeyPem); }
    catch { throw new PluginInstallError("INVALID_PUBLISHER_KEY", "Publisher Ed25519 public key is invalid"); }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new PluginInstallError("INVALID_PUBLISHER_KEY", "Publisher key must be Ed25519");
    }
    const fingerprint = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
    const existing = this.db.raw.prepare("SELECT key_fingerprint FROM plugin_publishers WHERE id = ?")
      .get(id) as { key_fingerprint: string } | undefined;
    if (existing && existing.key_fingerprint !== fingerprint) {
      throw new PluginInstallError("PUBLISHER_KEY_CONFLICT", "Publisher already has a different trusted key", 409);
    }
    this.db.raw.prepare(
      "INSERT OR IGNORE INTO plugin_publishers(id, public_key_pem, key_fingerprint, trusted_at) VALUES (?, ?, ?, ?)",
    ).run(id, key.export({ type: "spki", format: "pem" }), fingerprint, new Date().toISOString());
    return { id, fingerprint };
  }

  trustedPublishers(): Array<{ id: string; fingerprint: string }> {
    return this.db.raw.prepare("SELECT id, key_fingerprint AS fingerprint FROM plugin_publishers ORDER BY id")
      .all() as Array<{ id: string; fingerprint: string }>;
  }

  install(archive: Uint8Array): { id: string; version: string; publisher: string; signed: boolean; archiveSha256: string } {
    const trustRows = this.db.raw.prepare("SELECT id, public_key_pem FROM plugin_publishers")
      .all() as Array<{ id: string; public_key_pem: string }>;
    let verified;
    try {
      verified = verifyPlugin(archive, new Map(trustRows.map((row) => [row.id, row.public_key_pem])), {
        developmentMode: this.developmentMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /not trusted/u.test(message) ? "UNTRUSTED_PUBLISHER" :
        /Unsigned plugins/u.test(message) ? "UNSIGNED_PLUGIN" : "INVALID_PLUGIN_PACKAGE";
      throw new PluginInstallError(code, "Plugin package failed verification");
    }
    const { manifest, files } = verified;
    if (!manifest.entrypoints[process.platform]) {
      throw new PluginInstallError("MISSING_PLATFORM_ENTRYPOINT", "Plugin has no entrypoint for this platform");
    }
    const sourceDefinitions = (manifest.sourceDefinitions ?? []).map((path) =>
      parseDefinition(files.get(path) as Uint8Array, "source") as SourceDefinition);
    const driverDefinitions = (manifest.driverDefinitions ?? []).map((path) =>
      parseDefinition(files.get(path) as Uint8Array, "driver") as DriverDefinition);
    validateSchemas(sourceDefinitions, driverDefinitions);
    // Reserve IDs of installed development packages even when production mode hides them.
    const current = new PluginRepository(this.db, true).catalog();
    const sourceIds = new Set(current.sourceDefinitions.map((definition) => definition.id));
    const driverIds = new Set(current.driverDefinitions.map((definition) => definition.id));
    for (const source of sourceDefinitions) {
      if (sourceIds.has(source.id)) throw new PluginInstallError("DUPLICATE_PLUGIN_DEFINITION", "Source definition ID already exists", 409);
      sourceIds.add(source.id);
    }
    for (const driver of driverDefinitions) {
      if (driverIds.has(driver.id)) throw new PluginInstallError("DUPLICATE_PLUGIN_DEFINITION", "Driver definition ID already exists", 409);
      driverIds.add(driver.id);
    }
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    try {
      this.db.raw.transaction(() => {
        const existing = this.db.raw.prepare("SELECT 1 FROM plugin_packages WHERE id = ? AND active = 1")
          .get(manifest.id);
        if (existing) throw new PluginInstallError("PLUGIN_ALREADY_INSTALLED", "Plugin is already installed", 409);
        this.db.raw.prepare(
          `INSERT INTO plugin_packages(id, version, publisher_id, signed, manifest_json,
            source_definitions_json, driver_definitions_json, archive_sha256, archive_blob, installed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(manifest.id, manifest.version, manifest.publisher, verified.signed ? 1 : 0,
          JSON.stringify(manifest), JSON.stringify(sourceDefinitions), JSON.stringify(driverDefinitions),
          archiveSha256, Buffer.from(archive), new Date().toISOString());
      })();
    } catch (error) {
      if (error instanceof PluginInstallError) throw error;
      throw new PluginInstallError("PLUGIN_INSTALL_FAILED", "Plugin could not be installed", 409);
    }
    return { id: manifest.id, version: manifest.version, publisher: manifest.publisher,
      signed: verified.signed, archiveSha256 };
  }

  installed(): Array<{ id: string; version: string; publisher: string; signed: boolean; archiveSha256: string; installedAt: string }> {
    const rows = this.db.raw.prepare(
      "SELECT id, version, publisher_id, signed, archive_sha256, installed_at FROM plugin_packages WHERE active = 1 ORDER BY id",
    ).all() as PackageRow[];
    return rows.map((row) => ({ id: row.id, version: row.version, publisher: row.publisher_id,
      signed: row.signed === 1, archiveSha256: row.archive_sha256, installedAt: row.installed_at }));
  }

  catalog(): Catalog {
    const rows = this.db.raw.prepare(
      "SELECT source_definitions_json, driver_definitions_json FROM plugin_packages WHERE active = 1 AND (signed = 1 OR ? = 1) ORDER BY id",
    ).all(this.developmentMode ? 1 : 0) as PackageRow[];
    return {
      sourceDefinitions: [...builtinCatalog.sourceDefinitions,
        ...rows.flatMap((row) => JSON.parse(row.source_definitions_json) as SourceDefinition[])],
      driverDefinitions: [...builtinCatalog.driverDefinitions,
        ...rows.flatMap((row) => JSON.parse(row.driver_definitions_json) as DriverDefinition[])],
    };
  }

  sourceDefinition(id: string): SourceDefinition | undefined {
    return this.catalog().sourceDefinitions.find((definition) => definition.id === id);
  }
}

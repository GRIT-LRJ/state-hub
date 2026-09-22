import { createHash, createPublicKey } from "node:crypto";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { verifyPlugin, type VerifiedPlugin } from "@state-hub/plugin-kit";
import type { Binding, DriverDefinition, SourceDefinition } from "@state-hub/protocol";
import { builtinCatalog } from "./builtins.js";
import type { StateHubDatabase } from "./database.js";

type Catalog = { sourceDefinitions: SourceDefinition[]; driverDefinitions: DriverDefinition[] };
interface PackageRow {
  id: string;
  version: string;
  publisher_id: string;
  signed: number;
  enabled: number;
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

export interface PluginUpgradeCandidate {
  id: string;
  fromVersion: string;
  fromArchiveSha256: string;
  version: string;
  publisher: string;
  signed: boolean;
  enabled: boolean;
  archiveSha256: string;
  archive: Buffer;
  verified: VerifiedPlugin;
  sourceDefinitions: SourceDefinition[];
  driverDefinitions: DriverDefinition[];
  oldSourceDefinitionIds: string[];
  oldDriverDefinitionIds: string[];
}

export interface PluginDependencies {
  driverInstances: string[];
  bindings: string[];
  producers: string[];
  deliveries: string[];
}

export class PluginDependencyError extends PluginInstallError {
  constructor(readonly dependencies: PluginDependencies) {
    super("PLUGIN_IN_USE", "Resolve the listed plugin dependencies and pending deliveries before uninstalling", 409);
  }
}

function dependencyHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
    // Reserve IDs even when a package is disabled or hidden by production mode.
    const installedDefinitions = this.db.raw.prepare(
      "SELECT source_definitions_json, driver_definitions_json FROM plugin_packages WHERE active = 1",
    ).all() as PackageRow[];
    const sourceIds = new Set([
      ...builtinCatalog.sourceDefinitions.map((definition) => definition.id),
      ...installedDefinitions.flatMap((row) =>
        (JSON.parse(row.source_definitions_json) as SourceDefinition[]).map((definition) => definition.id)),
    ]);
    const driverIds = new Set([
      ...builtinCatalog.driverDefinitions.map((definition) => definition.id),
      ...installedDefinitions.flatMap((row) =>
        (JSON.parse(row.driver_definitions_json) as DriverDefinition[]).map((definition) => definition.id)),
    ]);
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

  inspectUpgrade(id: string, archive: Uint8Array): PluginUpgradeCandidate {
    const current = this.db.raw.prepare(
      `SELECT version, publisher_id, signed, enabled, archive_sha256,
              source_definitions_json, driver_definitions_json
       FROM plugin_packages WHERE id = ? AND active = 1`,
    ).get(id) as PackageRow | undefined;
    if (!current) throw new PluginInstallError("PLUGIN_NOT_FOUND", "Plugin package was not found", 404);
    const trustRows = this.db.raw.prepare("SELECT id, public_key_pem FROM plugin_publishers")
      .all() as Array<{ id: string; public_key_pem: string }>;
    let verified: VerifiedPlugin;
    try {
      verified = verifyPlugin(archive, new Map(trustRows.map((row) => [row.id, row.public_key_pem])), {
        developmentMode: this.developmentMode,
      });
    } catch {
      throw new PluginInstallError("INVALID_PLUGIN_PACKAGE", "Upgrade package failed verification");
    }
    const { manifest, files } = verified;
    if (manifest.id !== id || manifest.publisher !== current.publisher_id ||
      (current.signed === 1 && !verified.signed)) {
      throw new PluginInstallError("PLUGIN_UPGRADE_IDENTITY", "Upgrade identity or publisher does not match", 409);
    }
    if (manifest.version === current.version || this.db.raw.prepare(
      "SELECT 1 FROM plugin_packages WHERE id = ? AND version = ?",
    ).get(id, manifest.version)) {
      throw new PluginInstallError("PLUGIN_VERSION_CONFLICT", "Plugin version is already installed", 409);
    }
    if (!manifest.entrypoints[process.platform]) {
      throw new PluginInstallError("MISSING_PLATFORM_ENTRYPOINT", "Plugin has no entrypoint for this platform");
    }
    let sourceDefinitions: SourceDefinition[];
    let driverDefinitions: DriverDefinition[];
    try {
      sourceDefinitions = (manifest.sourceDefinitions ?? []).map((path) =>
        parseDefinition(files.get(path) as Uint8Array, "source") as SourceDefinition);
      driverDefinitions = (manifest.driverDefinitions ?? []).map((path) =>
        parseDefinition(files.get(path) as Uint8Array, "driver") as DriverDefinition);
      validateSchemas(sourceDefinitions, driverDefinitions);
    } catch (error) {
      if (error instanceof PluginInstallError) throw error;
      throw new PluginInstallError("INVALID_PLUGIN_DEFINITION", "Upgrade definition is invalid");
    }
    const otherRows = this.db.raw.prepare(
      `SELECT source_definitions_json, driver_definitions_json FROM plugin_packages
       WHERE active = 1 AND id <> ?`,
    ).all(id) as PackageRow[];
    const sourceIds = new Set([...builtinCatalog.sourceDefinitions.map((entry) => entry.id),
      ...otherRows.flatMap((row) => (JSON.parse(row.source_definitions_json) as SourceDefinition[])
        .map((entry) => entry.id))]);
    const driverIds = new Set([...builtinCatalog.driverDefinitions.map((entry) => entry.id),
      ...otherRows.flatMap((row) => (JSON.parse(row.driver_definitions_json) as DriverDefinition[])
        .map((entry) => entry.id))]);
    for (const definition of sourceDefinitions) {
      if (sourceIds.has(definition.id)) {
        throw new PluginInstallError("DUPLICATE_PLUGIN_DEFINITION", "Source definition ID already exists", 409);
      }
      sourceIds.add(definition.id);
    }
    for (const definition of driverDefinitions) {
      if (driverIds.has(definition.id)) {
        throw new PluginInstallError("DUPLICATE_PLUGIN_DEFINITION", "Driver definition ID already exists", 409);
      }
      driverIds.add(definition.id);
    }
    const oldSourceDefinitionIds = (JSON.parse(current.source_definitions_json) as SourceDefinition[])
      .map((entry) => entry.id);
    const oldDriverDefinitionIds = (JSON.parse(current.driver_definitions_json) as DriverDefinition[])
      .map((entry) => entry.id);
    return {
      id, fromVersion: current.version, fromArchiveSha256: current.archive_sha256,
      version: manifest.version, publisher: manifest.publisher, signed: verified.signed,
      enabled: current.enabled === 1, archiveSha256: createHash("sha256").update(archive).digest("hex"),
      archive: Buffer.from(archive), verified, sourceDefinitions, driverDefinitions,
      oldSourceDefinitionIds, oldDriverDefinitionIds,
    };
  }

  catalogForUpgrade(candidate: PluginUpgradeCandidate): Catalog {
    const current = this.catalog();
    const oldSources = new Set(candidate.oldSourceDefinitionIds);
    const oldDrivers = new Set(candidate.oldDriverDefinitionIds);
    return {
      sourceDefinitions: [...current.sourceDefinitions.filter((entry) => !oldSources.has(entry.id)),
        ...candidate.sourceDefinitions],
      driverDefinitions: [...current.driverDefinitions.filter((entry) => !oldDrivers.has(entry.id)),
        ...candidate.driverDefinitions],
    };
  }

  activateUpgrade(candidate: PluginUpgradeCandidate): void {
    const current = this.db.raw.prepare(
      "SELECT version, archive_sha256 FROM plugin_packages WHERE id = ? AND active = 1",
    ).get(candidate.id) as { version: string; archive_sha256: string } | undefined;
    if (!current || current.version !== candidate.fromVersion ||
      current.archive_sha256 !== candidate.fromArchiveSha256) {
      throw new PluginInstallError("PLUGIN_UPGRADE_STALE_BASE", "Active plugin changed during upgrade", 409);
    }
    this.db.raw.prepare("UPDATE plugin_packages SET active = 0 WHERE id = ? AND active = 1").run(candidate.id);
    this.db.raw.prepare(
      `INSERT INTO plugin_packages(id, version, publisher_id, signed, manifest_json,
         source_definitions_json, driver_definitions_json, archive_sha256, archive_blob,
         installed_at, active, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(candidate.id, candidate.version, candidate.publisher, candidate.signed ? 1 : 0,
      JSON.stringify(candidate.verified.manifest), JSON.stringify(candidate.sourceDefinitions),
      JSON.stringify(candidate.driverDefinitions), candidate.archiveSha256, candidate.archive,
      new Date().toISOString(), candidate.enabled ? 1 : 0);
  }

  installed(): Array<{ id: string; version: string; publisher: string; signed: boolean; enabled: boolean; archiveSha256: string; installedAt: string }> {
    const rows = this.db.raw.prepare(
      "SELECT id, version, publisher_id, signed, enabled, archive_sha256, installed_at FROM plugin_packages WHERE active = 1 ORDER BY id",
    ).all() as PackageRow[];
    return rows.map((row) => ({ id: row.id, version: row.version, publisher: row.publisher_id,
      signed: row.signed === 1, enabled: row.enabled === 1,
      archiveSha256: row.archive_sha256, installedAt: row.installed_at }));
  }

  catalog(): Catalog {
    const rows = this.db.raw.prepare(
      "SELECT source_definitions_json, driver_definitions_json FROM plugin_packages WHERE active = 1 AND enabled = 1 AND (signed = 1 OR ? = 1) ORDER BY id",
    ).all(this.developmentMode ? 1 : 0) as PackageRow[];
    return {
      sourceDefinitions: [...builtinCatalog.sourceDefinitions,
        ...rows.flatMap((row) => JSON.parse(row.source_definitions_json) as SourceDefinition[])],
      driverDefinitions: [...builtinCatalog.driverDefinitions,
        ...rows.flatMap((row) => JSON.parse(row.driver_definitions_json) as DriverDefinition[])],
    };
  }

  setEnabled(id: string, enabled: boolean): void {
    const changed = this.db.raw.prepare(
      "UPDATE plugin_packages SET enabled = ? WHERE id = ? AND active = 1",
    ).run(enabled ? 1 : 0, id);
    if (changed.changes !== 1) throw new PluginInstallError("PLUGIN_NOT_FOUND", "Plugin package was not found", 404);
  }

  runtimePackageIds(): string[] {
    return (this.db.raw.prepare(
      "SELECT id FROM plugin_packages WHERE active = 1 AND enabled = 1 AND (signed = 1 OR ? = 1) ORDER BY id",
    ).all(this.developmentMode ? 1 : 0) as Array<{ id: string }>).map((row) => row.id);
  }

  hasInstalledDriverType(driverType: string): boolean {
    const rows = this.db.raw.prepare(
      "SELECT driver_definitions_json FROM plugin_packages WHERE active = 1 AND (signed = 1 OR ? = 1)",
    ).all(this.developmentMode ? 1 : 0) as Array<{ driver_definitions_json: string }>;
    return rows.some((row) => (JSON.parse(row.driver_definitions_json) as DriverDefinition[])
      .some((definition) => definition.id === driverType));
  }

  packageForDriver(driverType: string): string | undefined {
    const rows = this.db.raw.prepare(
      "SELECT id, driver_definitions_json FROM plugin_packages WHERE active = 1 AND enabled = 1 AND (signed = 1 OR ? = 1)",
    ).all(this.developmentMode ? 1 : 0) as Array<{ id: string; driver_definitions_json: string }>;
    return rows.find((row) =>
      (JSON.parse(row.driver_definitions_json) as DriverDefinition[]).some((definition) => definition.id === driverType))?.id;
  }

  dependencies(id: string): PluginDependencies {
    const row = this.db.raw.prepare(
      "SELECT source_definitions_json, driver_definitions_json FROM plugin_packages WHERE id = ? AND active = 1",
    ).get(id) as { source_definitions_json: string; driver_definitions_json: string } | undefined;
    if (!row) throw new PluginInstallError("PLUGIN_NOT_FOUND", "Plugin package was not found", 404);
    const driverTypes = new Set((JSON.parse(row.driver_definitions_json) as DriverDefinition[])
      .map((definition) => definition.id));
    const sourceTypes = new Set((JSON.parse(row.source_definitions_json) as SourceDefinition[])
      .map((definition) => definition.id));
    const instances = (this.db.raw.prepare("SELECT id, driver_type FROM driver_instances")
      .all() as Array<{ id: string; driver_type: string }>)
      .filter((instance) => driverTypes.has(instance.driver_type));
    const instanceIds = new Set(instances.map((instance) => instance.id));
    const bindings = (this.db.raw.prepare("SELECT id, payload_json FROM bindings")
      .all() as Array<{ id: string; payload_json: string }>)
      .filter((binding) => instanceIds.has(
        (JSON.parse(binding.payload_json) as Binding).target.driverInstanceId));
    const producers = (this.db.raw.prepare(
      "SELECT producer_id, source_definition_id FROM producer_tokens WHERE revoked_at IS NULL",
    ).all() as Array<{ producer_id: string; source_definition_id: string | null }>)
      .filter((producer) => producer.source_definition_id !== null &&
        sourceTypes.has(producer.source_definition_id));
    const historicalIds = new Set(instanceIds);
    const revisions = this.db.raw.prepare(
      "SELECT config_json FROM config_revisions WHERE status IN ('published', 'superseded')",
    ).all() as Array<{ config_json: string }>;
    for (const revision of revisions) {
      const config = JSON.parse(revision.config_json) as {
        driverInstances: Array<{ id: string; driverType: string }>;
      };
      for (const instance of config.driverInstances) {
        if (driverTypes.has(instance.driverType)) historicalIds.add(instance.id);
      }
    }
    const deliveries = (this.db.raw.prepare(
      "SELECT id, driver_instance_id FROM deliveries WHERE status IN ('pending', 'leased')",
    ).all() as Array<{ id: string; driver_instance_id: string }>)
      .filter((delivery) => historicalIds.has(delivery.driver_instance_id));
    return {
      driverInstances: instances.map((instance) => dependencyHash(instance.id)).sort(),
      bindings: bindings.map((binding) => dependencyHash(binding.id)).sort(),
      producers: producers.map((producer) => dependencyHash(producer.producer_id)).sort(),
      deliveries: deliveries.map((delivery) => dependencyHash(delivery.id)).sort(),
    };
  }

  uninstall(id: string): void {
    this.db.transaction(() => {
      const dependencies = this.dependencies(id);
      if (dependencies.driverInstances.length || dependencies.bindings.length || dependencies.producers.length || dependencies.deliveries.length) {
        throw new PluginDependencyError(dependencies);
      }
      this.db.raw.prepare("DELETE FROM plugin_packages WHERE id = ?").run(id);
    });
  }

  driverInstanceIds(id: string): string[] {
    const row = this.db.raw.prepare(
      "SELECT driver_definitions_json FROM plugin_packages WHERE id = ? AND active = 1 AND enabled = 1",
    ).get(id) as { driver_definitions_json: string } | undefined;
    if (!row) return [];
    const types = new Set((JSON.parse(row.driver_definitions_json) as DriverDefinition[])
      .map((definition) => definition.id));
    return (this.db.raw.prepare("SELECT id, driver_type FROM driver_instances WHERE enabled = 1")
      .all() as Array<{ id: string; driver_type: string }>)
      .filter((instance) => types.has(instance.driver_type)).map((instance) => instance.id);
  }

  runtimePackage(id: string): VerifiedPlugin {
    const row = this.db.raw.prepare(
      "SELECT version, signed, archive_sha256, archive_blob FROM plugin_packages WHERE id = ? AND active = 1 AND enabled = 1",
    ).get(id) as { version: string; signed: number; archive_sha256: string; archive_blob: Buffer } | undefined;
    if (!row || (row.signed !== 1 && !this.developmentMode)) {
      throw new PluginInstallError("PLUGIN_UNAVAILABLE", "Plugin package is unavailable");
    }
    if (createHash("sha256").update(row.archive_blob).digest("hex") !== row.archive_sha256) {
      throw new PluginInstallError("PLUGIN_ARCHIVE_CHANGED", "Installed plugin archive failed integrity verification");
    }
    const trustRows = this.db.raw.prepare("SELECT id, public_key_pem FROM plugin_publishers")
      .all() as Array<{ id: string; public_key_pem: string }>;
    let verified: VerifiedPlugin;
    try {
      verified = verifyPlugin(row.archive_blob, new Map(trustRows.map((entry) => [entry.id, entry.public_key_pem])), {
        developmentMode: this.developmentMode,
      });
    } catch {
      throw new PluginInstallError("PLUGIN_ARCHIVE_CHANGED", "Installed plugin archive failed integrity verification");
    }
    if (verified.manifest.id !== id || verified.manifest.version !== row.version ||
      verified.signed !== (row.signed === 1)) {
      throw new PluginInstallError("PLUGIN_ARCHIVE_CHANGED", "Installed plugin record does not match its archive");
    }
    return verified;
  }

  sourceDefinition(id: string): SourceDefinition | undefined {
    return this.catalog().sourceDefinitions.find((definition) => definition.id === id);
  }
}

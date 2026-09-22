import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { PluginConfigMigrationResult } from "@state-hub/protocol";
import { ConfigValidationError, validatePublishedConfig } from "./config-validation.js";
import type { StateHubDatabase } from "./database.js";
import { PluginInstallError, type PluginRepository, type PluginUpgradeCandidate } from "./plugin-repository.js";
import type { PublishedConfig } from "./service.js";

type Validator = (value: unknown) => boolean;
type AjvInstance = { compile(schema: object): Validator; addFormat(name: string, pattern: RegExp): void };
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as
  new (options: object) => AjvInstance;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as
  (instance: AjvInstance) => void;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function incompatible(code: string): never {
  throw new PluginInstallError(code, "Upgrade is incompatible with current plugin usage", 409);
}

/** Validates the candidate against data that will survive the version switch. */
export function migratedUpgradeConfig(
  db: StateHubDatabase,
  plugins: PluginRepository,
  candidate: PluginUpgradeCandidate,
  current: PublishedConfig,
  migration: unknown,
): PublishedConfig {
  const ownedTypes = new Set(candidate.oldDriverDefinitionIds);
  const owned = current.driverInstances.filter((instance) => ownedTypes.has(instance.driverType));
  const ownedIds = new Set(owned.map((instance) => instance.id));
  if (!record(migration) || !Array.isArray(migration.driverInstances) ||
    migration.driverInstances.length !== owned.length) incompatible("PLUGIN_MIGRATION_RESULT");
  const migrated = migration as unknown as PluginConfigMigrationResult;
  const replacements = new Map<string, Record<string, unknown>>();
  for (const item of migrated.driverInstances) {
    if (!record(item) || typeof item.id !== "string" || !ownedIds.has(item.id) ||
      replacements.has(item.id) || !record(item.config)) incompatible("PLUGIN_MIGRATION_RESULT");
    replacements.set(item.id, item.config);
  }
  if (replacements.size !== owned.length) incompatible("PLUGIN_MIGRATION_RESULT");
  const next: PublishedConfig = {
    bindings: current.bindings,
    driverInstances: current.driverInstances.map((instance) => ({
      ...instance, config: replacements.get(instance.id) ?? instance.config,
    })),
  };
  try { validatePublishedConfig(next, plugins, plugins.catalogForUpgrade(candidate)); }
  catch (error) {
    if (error instanceof ConfigValidationError) incompatible("PLUGIN_SCHEMA_INCOMPATIBLE");
    throw error;
  }

  const sources = new Map(candidate.sourceDefinitions.map((entry) => [entry.id, entry]));
  const oldSources = new Set(candidate.oldSourceDefinitionIds);
  const registered = db.raw.prepare(
    "SELECT DISTINCT source_definition_id FROM producer_tokens WHERE revoked_at IS NULL AND source_definition_id IS NOT NULL",
  ).all() as Array<{ source_definition_id: string }>;
  for (const producer of registered) {
    if (oldSources.has(producer.source_definition_id) && !sources.has(producer.source_definition_id)) {
      incompatible("PLUGIN_SOURCE_INCOMPATIBLE");
    }
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat("statehub-secret-ref", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
  const claims = db.raw.prepare(
    `SELECT c.signal_id, c.value_json, p.source_definition_id
     FROM claims c JOIN producer_tokens p ON p.producer_id = c.producer_id
     WHERE p.revoked_at IS NULL AND p.source_definition_id IS NOT NULL`,
  ).all() as Array<{ source_definition_id: string; signal_id: string; value_json: string }>;
  for (const claim of claims) {
    if (!oldSources.has(claim.source_definition_id)) continue;
    const schema = sources.get(claim.source_definition_id)?.claimSchemas[claim.signal_id];
    if (!schema || !ajv.compile(schema)(JSON.parse(claim.value_json) as unknown)) {
      incompatible("PLUGIN_SOURCE_INCOMPATIBLE");
    }
  }

  const definitions = new Map(candidate.driverDefinitions.map((entry) => [entry.id, entry]));
  const pending = db.raw.prepare(
    "SELECT driver_instance_id, action_kind, action_json FROM deliveries WHERE status IN ('pending', 'leased')",
  ).all() as Array<{ driver_instance_id: string; action_kind: string; action_json: string | null }>;
  const byId = new Map(next.driverInstances.map((instance) => [instance.id, instance]));
  for (const delivery of pending) {
    if (!ownedIds.has(delivery.driver_instance_id) || delivery.action_json === null) continue;
    const type = byId.get(delivery.driver_instance_id)?.driverType;
    const action = JSON.parse(delivery.action_json) as { name?: string; params?: unknown };
    const contract = definitions.get(type ?? "")?.actions[action.name ?? ""];
    if (!contract || contract.kind !== delivery.action_kind ||
      !ajv.compile(contract.paramsSchema)(action.params)) incompatible("PLUGIN_DELIVERY_INCOMPATIBLE");
  }
  return next;
}

import AjvModule, { type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { StateHubDatabase } from "./database.js";
import { builtinCatalog } from "./builtins.js";
import { PluginRepository } from "./plugin-repository.js";

type AjvInstance = {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ValidateFunction["errors"], options?: { separator?: string; dataVar?: string }): string;
};
const AjvConstructor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (
  options: object,
) => AjvInstance;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  instance: AjvInstance,
) => void;
const ajv = new AjvConstructor({ allErrors: true, strict: false });
addFormats(ajv);
const claimValidators = new Map<string, ValidateFunction>();
const eventValidators = new Map<string, ValidateFunction>();

for (const source of builtinCatalog.sourceDefinitions) {
  for (const [signalId, schema] of Object.entries(source.claimSchemas)) {
    claimValidators.set(`${source.id}\u001f${signalId}`, ajv.compile(schema));
  }
  for (const [eventType, schema] of Object.entries(source.eventSchemas)) {
    eventValidators.set(`${source.id}\u001f${eventType}`, ajv.compile(schema));
  }
}

const installedValidators = new WeakMap<StateHubDatabase, Map<string, ValidateFunction>>();

function installedValidator(
  db: StateHubDatabase,
  plugins: PluginRepository,
  definitionId: string,
  kind: "claim" | "event",
  name: string,
): ValidateFunction | undefined {
  const source = plugins.sourceDefinition(definitionId);
  const schema = kind === "claim" ? source?.claimSchemas[name] : source?.eventSchemas[name];
  if (!schema) return undefined;
  let cache = installedValidators.get(db);
  if (!cache) {
    cache = new Map();
    installedValidators.set(db, cache);
  }
  const key = JSON.stringify([source?.id, source?.version, kind, name, schema]);
  let validator = cache.get(key);
  if (!validator) {
    const pluginAjv = new AjvConstructor({ allErrors: true, strict: false });
    addFormats(pluginAjv);
    validator = pluginAjv.compile(schema);
    cache.set(key, validator);
  }
  return validator;
}

function producerDefinition(db: StateHubDatabase, producerId: string): string | undefined {
  const row = db.raw
    .prepare("SELECT source_definition_id FROM producer_tokens WHERE producer_id = ?")
    .get(producerId) as { source_definition_id: string | null } | undefined;
  return row?.source_definition_id ?? undefined;
}

function describe(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors, { separator: "; ", dataVar: "value" });
}

export function validateClaimValue(
  db: StateHubDatabase,
  producerId: string,
  signalId: string,
  value: unknown,
  plugins: PluginRepository = new PluginRepository(db),
): string | undefined {
  const definition = producerDefinition(db, producerId);
  if (!definition) return undefined;
  const validate = claimValidators.get(`${definition}\u001f${signalId}`) ??
    installedValidator(db, plugins, definition, "claim", signalId);
  if (!validate) return `Signal ${signalId} is not declared by source definition ${definition}`;
  return validate(value) ? undefined : describe(validate);
}

export function validateEventValue(
  db: StateHubDatabase,
  producerId: string,
  eventType: string,
  value: unknown,
  plugins: PluginRepository = new PluginRepository(db),
): string | undefined {
  const definition = producerDefinition(db, producerId);
  if (!definition) return undefined;
  const validate = eventValidators.get(`${definition}\u001f${eventType}`) ??
    installedValidator(db, plugins, definition, "event", eventType);
  if (!validate) return `Event ${eventType} is not declared by source definition ${definition}`;
  return validate(value) ? undefined : describe(validate);
}

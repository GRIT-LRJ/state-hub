import AjvModule, { type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { Binding, DriverDefinition } from "@state-hub/protocol";
import { PluginRepository } from "./plugin-repository.js";

type AjvInstance = { compile(schema: object): ValidateFunction; addFormat(name: string, format: RegExp): void };
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (
  options: object,
) => AjvInstance;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  instance: AjvInstance,
) => void;

export class ConfigValidationError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) {
    super(code);
  }
}

function validator(schema: object): ValidateFunction {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat("statehub-secret-ref", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
  return ajv.compile(schema);
}

const configShape = validator({
  type: "object", additionalProperties: false, required: ["bindings", "driverInstances"],
  properties: {
    driverInstances: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["id", "driverType", "enabled", "config"],
      properties: {
        id: { type: "string", minLength: 1 },
        driverType: { type: "string", minLength: 1 },
        enabled: { type: "boolean" },
        config: { type: "object" },
        physicalResourceKey: { type: "string", minLength: 1 },
      },
    } },
    bindings: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["id", "name", "enabled", "selector", "conditions", "mapping", "target"],
      properties: {
        id: { type: "string", minLength: 1 }, name: { type: "string" }, enabled: { type: "boolean" },
        selector: { type: "object", additionalProperties: false, properties: {
          producerId: { type: "string", minLength: 1 }, sourceType: { type: "string", minLength: 1 },
          scopePattern: { type: "string" }, signalId: { type: "string", minLength: 1 },
          eventType: { type: "string", minLength: 1 },
        } },
        conditions: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["pointer", "operator"], properties: {
            pointer: { type: "string" },
            operator: { enum: ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"] },
            value: {},
          },
        } },
        mapping: { type: "object", additionalProperties: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["kind", "value"],
              properties: { kind: { const: "constant" }, value: {} } },
            { type: "object", additionalProperties: false, required: ["kind", "pointer"],
              properties: { kind: { const: "pointer" }, pointer: { type: "string" } } },
            { type: "object", additionalProperties: false, required: ["kind", "template"],
              properties: { kind: { const: "template" }, template: { type: "string" } } },
          ],
        } },
        target: { type: "object", additionalProperties: false,
          required: ["driverInstanceId", "resourceChannel", "actionKind", "actionName"],
          properties: {
            driverInstanceId: { type: "string", minLength: 1 },
            resourceChannel: { type: "string", minLength: 1 },
            actionKind: { enum: ["stateful", "queued-effect", "append-only"] },
            actionName: { type: "string", minLength: 1 },
            physicalResourceKey: { type: "string", minLength: 1 },
          },
        },
        urgencyOverride: { enum: ["ambient", "informational", "action-required", "critical"] },
        order: { type: "integer" }, honorAcknowledgement: { type: "boolean" },
        transitionOnly: { type: "boolean" }, batchWindowMs: { type: "integer", minimum: 0 },
      },
    } },
  },
});

const legacyDriverAliases: Record<string, string> = {
  virtual: "official.virtual", http: "official.http", pushplus: "official.pushplus", vk87: "official.vk87",
};

function validPointer(value: string): boolean {
  return value === "" || (value.startsWith("/") && !/~(?![01])/u.test(value));
}

const forbiddenHttpHeader = /^(host|authorization|cookie|proxy-authorization|proxy-.*|x-api-key|content-length|transfer-encoding|connection|upgrade)$/iu;

function validateHttpConfig(config: Record<string, unknown>): void {
  let target: URL;
  try { target = new URL(config.baseUrl as string); }
  catch { throw new ConfigValidationError("INVALID_DRIVER_CONFIG"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new ConfigValidationError("INVALID_DRIVER_CONFIG");
  }
  if (config.privateTargetOrigin !== undefined) {
    let grant: URL;
    try { grant = new URL(config.privateTargetOrigin as string); }
    catch { throw new ConfigValidationError("INVALID_DRIVER_CONFIG"); }
    if (!["http:", "https:"].includes(grant.protocol) || grant.username || grant.password ||
      grant.pathname !== "/" || grant.search || grant.hash || grant.origin !== target.origin) {
      throw new ConfigValidationError("INVALID_DRIVER_CONFIG");
    }
  }
  if (Object.keys((config.headers ?? {}) as Record<string, string>).some((name) =>
    forbiddenHttpHeader.test(name))) {
    throw new ConfigValidationError("INVALID_DRIVER_CONFIG");
  }
}

const runtimeActionValidators = new Map<string, ValidateFunction>();

export function validMappedAction(driverType: string, name: string, kind: string,
  params: Record<string, unknown>, plugins: PluginRepository): boolean {
  const definition = plugins.catalog().driverDefinitions.find((entry) =>
    entry.id === (legacyDriverAliases[driverType] ?? driverType));
  if (!definition) return true;
  const action = definition.actions[name];
  if (!action || action.kind !== kind) return false;
  const key = JSON.stringify([definition.id, definition.version, name, action.paramsSchema]);
  let check = runtimeActionValidators.get(key);
  if (!check) {
    check = validator(action.paramsSchema);
    runtimeActionValidators.set(key, check);
  }
  return check(params);
}

function validateBinding(binding: Binding, definition: DriverDefinition): void {
  const action = definition.actions[binding.target.actionName];
  if (!action || action.kind !== binding.target.actionKind) {
    throw new ConfigValidationError("INVALID_ACTION_CONTRACT");
  }
  if (binding.batchWindowMs !== undefined && binding.target.actionKind === "stateful") {
    throw new ConfigValidationError("INVALID_BATCH_WINDOW");
  }
  if ((binding.selector.signalId && binding.selector.eventType) ||
    (binding.target.actionKind === "stateful" && binding.selector.eventType)) {
    throw new ConfigValidationError("INVALID_SELECTOR");
  }
  if (binding.batchWindowMs !== undefined && !Number.isSafeInteger(binding.batchWindowMs)) {
    throw new ConfigValidationError("INVALID_BATCH_WINDOW");
  }
  if (binding.order !== undefined && !Number.isSafeInteger(binding.order)) {
    throw new ConfigValidationError("INVALID_CONFIG_SHAPE");
  }
  if (binding.conditions.some((item) => !validPointer(item.pointer)) ||
    Object.values(binding.mapping).some((item) =>
      (item.kind === "pointer" && !validPointer(item.pointer)) ||
      (item.kind === "template" && [...item.template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/gu)]
        .some((match) => !validPointer(match[1]!.trim()))))) {
    throw new ConfigValidationError("INVALID_JSON_POINTER");
  }
  const paramsSchema = action.paramsSchema;
  const properties = paramsSchema.properties as Record<string, object> | undefined;
  const additionalProperties = paramsSchema.additionalProperties;
  for (const [name, expression] of Object.entries(binding.mapping)) {
    if (!properties?.[name] && additionalProperties === false) {
      throw new ConfigValidationError("INVALID_ACTION_MAPPING");
    }
    if (expression.kind === "constant" && properties?.[name] && !validator(properties[name])(expression.value)) {
      throw new ConfigValidationError("INVALID_ACTION_MAPPING");
    }
  }
  if (Object.values(binding.mapping).every((item) => item.kind === "constant") &&
    !validator(paramsSchema)(Object.fromEntries(Object.entries(binding.mapping)
      .map(([key, item]) => [key, item.kind === "constant" ? item.value : undefined])))) {
    throw new ConfigValidationError("INVALID_ACTION_MAPPING");
  }
}

export function validatePublishedConfig(config: unknown, plugins: PluginRepository,
  catalog = plugins.catalog()): void {
  if (!configShape(config)) throw new ConfigValidationError("INVALID_CONFIG_SHAPE");
  const candidate = config as { driverInstances: Array<{
    id: string; driverType: string; enabled: boolean; config: Record<string, unknown>; physicalResourceKey?: string;
  }>; bindings: Binding[] };
  const definitions = new Map(catalog.driverDefinitions.map((definition) => [definition.id, definition]));
  const sources = new Map(catalog.sourceDefinitions.map((definition) => [definition.id, definition]));
  const instanceIds = new Set<string>();
  const physicalKeys = new Map<string, string>();
  const bindingPhysicalKeys = new Map<string, string>();
  for (const instance of candidate.driverInstances) {
    if (instanceIds.has(instance.id)) throw new ConfigValidationError("DUPLICATE_DRIVER_INSTANCE");
    instanceIds.add(instance.id);
    const definition = definitions.get(legacyDriverAliases[instance.driverType] ?? instance.driverType);
    if (!definition) throw new ConfigValidationError("UNKNOWN_DRIVER_TYPE");
    if (!validator(definition.configSchema)(instance.config)) throw new ConfigValidationError("INVALID_DRIVER_CONFIG");
    if (definition.id === "official.http") validateHttpConfig(instance.config);
    if (definition.id === "official.pushplus" && instance.config.endpoint !== undefined) {
      validateHttpConfig({ baseUrl: instance.config.endpoint });
    }
    if (instance.physicalResourceKey) {
      if (physicalKeys.has(instance.physicalResourceKey)) throw new ConfigValidationError("PHYSICAL_RESOURCE_CONFLICT", 409);
      physicalKeys.set(instance.physicalResourceKey, instance.id);
    }
  }
  const bindingIds = new Set<string>();
  for (const binding of candidate.bindings) {
    if (bindingIds.has(binding.id)) throw new ConfigValidationError("DUPLICATE_BINDING");
    bindingIds.add(binding.id);
    const instance = candidate.driverInstances.find((entry) => entry.id === binding.target.driverInstanceId);
    if (!instance) throw new ConfigValidationError("UNKNOWN_DRIVER_INSTANCE");
    if (binding.enabled && !instance.enabled) throw new ConfigValidationError("DISABLED_DRIVER_INSTANCE");
    if (binding.selector.sourceType) {
      const source = sources.get(binding.selector.sourceType);
      if (!source) throw new ConfigValidationError("UNKNOWN_SOURCE_TYPE");
      if (binding.selector.signalId && !source.claimSchemas[binding.selector.signalId]) {
        throw new ConfigValidationError("UNKNOWN_SOURCE_SIGNAL");
      }
      if (binding.selector.eventType && !source.eventSchemas[binding.selector.eventType]) {
        throw new ConfigValidationError("UNKNOWN_SOURCE_EVENT");
      }
    }
    if (binding.target.physicalResourceKey) {
      const physicalKey = binding.target.physicalResourceKey;
      const owner = physicalKeys.get(physicalKey);
      const bindingResource = JSON.stringify([instance.id, binding.target.resourceChannel]);
      const previousResource = bindingPhysicalKeys.get(physicalKey);
      if ((owner && owner !== instance.id) || (previousResource && previousResource !== bindingResource)) {
        throw new ConfigValidationError("PHYSICAL_RESOURCE_CONFLICT", 409);
      }
      physicalKeys.set(physicalKey, instance.id);
      bindingPhysicalKeys.set(physicalKey, bindingResource);
    }
    const definition = definitions.get(legacyDriverAliases[instance.driverType] ?? instance.driverType);
    if (!definition) throw new ConfigValidationError("UNKNOWN_DRIVER_TYPE");
    validateBinding(binding, definition);
  }
}

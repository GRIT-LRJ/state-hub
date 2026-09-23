import type { Binding, DriverDefinition } from "@state-hub/protocol";
import type { RJSFSchema } from "@rjsf/utils";
import type { ConfigInstance } from "./config-management.js";

const id: RJSFSchema = { type: "string", minLength: 1 };
const optionalText: RJSFSchema = { type: "string" };

function definitionFor(definitions: DriverDefinition[], driverType: string | undefined):
  DriverDefinition | undefined {
  return definitions.find((entry) => entry.id === driverType ||
    entry.id === `official.${driverType}`);
}

export function instanceSchema(definitions: DriverDefinition[], selectedType: string): RJSFSchema {
  const definition = definitionFor(definitions, selectedType);
  return {
    type: "object", additionalProperties: false,
    required: ["id", "driverType", "enabled", "config"],
    properties: {
      id,
      driverType: { type: "string", enum: [
        ...definitions.map((entry) => entry.id),
        ...(definition && selectedType !== definition.id ? [selectedType] : []),
      ] },
      enabled: { type: "boolean", default: true },
      physicalResourceKey: optionalText,
      config: (definition?.configSchema ?? { type: "object" }) as RJSFSchema,
    },
  };
}

export function bindingSchema(instances: ConfigInstance[], definitions: DriverDefinition[],
  selectedInstanceId: string): RJSFSchema {
  const instance = instances.find((entry) => entry.id === selectedInstanceId);
  const definition = definitionFor(definitions, instance?.driverType);
  const actions = Object.entries(definition?.actions ?? {});
  const expression = (kind: string, property: string): RJSFSchema => ({
    type: "object", additionalProperties: false, required: ["kind", property],
    properties: { kind: { const: kind }, [property]: kind === "constant" ? {} : optionalText },
  });
  return {
    type: "object", additionalProperties: false,
    required: ["id", "name", "enabled", "selector", "conditions", "mapping", "target"],
    properties: {
      id, name: optionalText, enabled: { type: "boolean", default: true },
      selector: { type: "object", additionalProperties: false, properties: {
        producerId: optionalText, sourceType: optionalText, scopePattern: optionalText,
        signalId: optionalText, eventType: optionalText,
      } },
      conditions: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["pointer", "operator"],
        properties: { pointer: optionalText,
          operator: { enum: ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"] },
          value: {},
        },
      } },
      mapping: { type: "object", additionalProperties: {
        oneOf: [expression("constant", "value"), expression("pointer", "pointer"),
          expression("template", "template")],
      } },
      target: { type: "object", additionalProperties: false,
        required: ["driverInstanceId", "resourceChannel", "actionKind", "actionName"],
        properties: {
          driverInstanceId: { type: "string", enum: instances.map((entry) => entry.id) },
          resourceChannel: optionalText,
          actionKind: { enum: [...new Set(actions.map(([, action]) => action.kind))] },
          actionName: { enum: actions.map(([name]) => name) },
          physicalResourceKey: optionalText,
        },
      },
      urgencyOverride: { enum: ["ambient", "informational", "action-required", "critical"] },
      order: { type: "integer" },
      honorAcknowledgement: { type: "boolean" },
      transitionOnly: { type: "boolean" },
      batchWindowMs: { type: "integer", minimum: 0 },
    },
  };
}

export function newBinding(instances: ConfigInstance[], definitions: DriverDefinition[]): Binding {
  const instance = instances[0];
  const definition = definitionFor(definitions, instance?.driverType);
  const [actionName, action] = Object.entries(definition?.actions ?? {})[0] ?? ["", { kind: "stateful" as const }];
  return {
    id: "", name: "", enabled: true, selector: {}, conditions: [], mapping: {},
    target: { driverInstanceId: instance?.id ?? "", resourceChannel: "", actionKind: action.kind, actionName },
  };
}

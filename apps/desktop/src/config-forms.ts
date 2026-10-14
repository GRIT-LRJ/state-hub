import type { Binding, DriverDefinition } from "@state-hub/protocol";
import type { RJSFSchema } from "@rjsf/utils";
import type { ConfigInstance } from "./config-management.js";

const id: RJSFSchema = { type: "string", minLength: 1 };
const optionalText: RJSFSchema = { type: "string" };
const driverLabel = (type: string): string => ({ virtual: "虚拟输出（本地验证）", pushplus: "PushPlus 通知",
  http: "HTTP 服务", vk87: "VK87 键盘" })[type.replace(/^official\./u, "")] ?? type;

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
      id: { ...id, title: "输出标识", description: "为这个设备或服务取一个唯一标识，规则通过它选择输出。" },
      driverType: { title: "输出类型", type: "string", oneOf: [
        ...definitions.map((entry) => entry.id),
        ...(definition && selectedType !== definition.id ? [selectedType] : []),
      ].map((value) => ({ const: value, title: driverLabel(value) })) },
      enabled: { title: "配置启用", type: "boolean", default: true },
      physicalResourceKey: { ...optionalText, title: "物理资源标识（可选）", description: "用于标识实际设备资源；没有需要时保持为空。" },
      config: { ...(definition?.configSchema ?? { type: "object" }) as RJSFSchema, title: "设备或服务参数" },
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
      id: { ...id, title: "规则标识" }, name: { ...optionalText, title: "显示名称" }, enabled: { title: "启用规则", type: "boolean", default: true },
      selector: { title: "来源与信号", type: "object", additionalProperties: false, properties: {
        producerId: { ...optionalText, title: "生产者 ID", description: "填写来源栏中接入方的标识。留空表示所有生产者。" },
        sourceType: { ...optionalText, title: "来源类型（可选）" },
        scopePattern: { ...optionalText, title: "作用域匹配", description: "作用域通常对应会话或任务；* 表示全部。" },
        signalId: { ...optionalText, title: "状态信号", description: "例如 Codex 的 status。" },
        eventType: { ...optionalText, title: "事件类型", description: "一次性事件的类型，例如自定义来源的 custom。" },
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
      target: { title: "目标输出", type: "object", additionalProperties: false,
        required: ["driverInstanceId", "resourceChannel", "actionKind", "actionName"],
        properties: {
          driverInstanceId: { title: "选择输出", type: "string", enum: instances.map((entry) => entry.id) },
          resourceChannel: { ...optionalText, title: "输出通道", description: "同一设备上需要共同协调的位置，例如 light 或 messages。" },
          actionKind: { title: "动作类别", description: "stateful 持续呈现状态；queued-effect 一次性效果；append-only 逐条投递事件。",
            enum: [...new Set(actions.map(([, action]) => action.kind))] },
          actionName: { title: "动作名称", enum: actions.map(([name]) => name) },
          physicalResourceKey: { ...optionalText, title: "物理资源标识（可选）" },
        },
      },
      urgencyOverride: { title: "覆盖紧急度", description: "从低到高：ambient、informational、action-required、critical。",
        enum: ["ambient", "informational", "action-required", "critical"] },
      order: { title: "规则顺序", type: "integer" },
      honorAcknowledgement: { title: "尊重状态版本确认", type: "boolean" },
      transitionOnly: { title: "仅在状态值变化时触发", type: "boolean" },
      batchWindowMs: { title: "批处理窗口（毫秒）", type: "integer", minimum: 0 },
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

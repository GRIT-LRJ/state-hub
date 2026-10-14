import type { Binding } from "@state-hub/protocol";
import { putBinding, putInstance, type ConfigInstance, type ManagedConfig } from "./config-management.js";

export type ConfigOperation =
  | { kind: "output"; id: string; before: ConfigInstance | undefined; after: ConfigInstance | undefined }
  | { kind: "rule"; id: string; before: Binding | undefined; after: Binding | undefined;
      dependency: ConfigInstance | undefined };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const sameConfigValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Rebase only the user's single operation; never include another editor's values. */
export function applyOperation(current: ManagedConfig, operation: ConfigOperation): ManagedConfig {
  if (operation.kind === "output") {
    const actual = current.driverInstances.find((item) => item.id === operation.id);
    if (!sameConfigValue(actual, operation.before)) throw new Error("EDIT_CONFLICT");
    if (!operation.after) {
      if (current.bindings.some((item) => item.target.driverInstanceId === operation.id)) {
        throw new Error("OUTPUT_IN_USE");
      }
      return { ...current, driverInstances: current.driverInstances.filter((item) => item.id !== operation.id) };
    }
    return putInstance(current, operation.after, operation.before?.id);
  }
  const actual = current.bindings.find((item) => item.id === operation.id);
  if (!sameConfigValue(actual, operation.before)) throw new Error("EDIT_CONFLICT");
  if (!operation.after) return { ...current, bindings: current.bindings.filter((item) => item.id !== operation.id) };
  const target = current.driverInstances.find((item) => item.id === operation.after!.target.driverInstanceId);
  if (!target || !sameConfigValue(target, operation.dependency)) throw new Error("OUTPUT_CHANGED");
  return putBinding(current, operation.after, operation.before?.id);
}

export function operationSummary(operation: ConfigOperation): string {
  const verb = !operation.after ? "移除" : operation.before ? "修改" : "新增";
  return `${verb}${operation.kind === "output" ? "输出" : "规则"}：${operation.id}`;
}

export function operationChanges(operation: ConfigOperation): string[] {
  const before = operation.before ?? {};
  const after = operation.after ?? {};
  const labels: Record<string, string> = { id: "标识", name: "名称", enabled: "启用", driverType: "输出类型",
    config: "设备或服务参数", physicalResourceKey: "物理资源", selector: "来源与信号", conditions: "触发条件",
    mapping: "内容映射", target: "目标输出与动作", urgencyOverride: "紧急度", order: "规则顺序",
    honorAcknowledgement: "尊重状态确认", transitionOnly: "仅状态变化触发", batchWindowMs: "批处理窗口" };
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
    const oldValue = (before as Record<string, unknown>)[key];
    const newValue = (after as Record<string, unknown>)[key];
    if (sameConfigValue(oldValue, newValue)) return [];
    const format = (value: unknown) => value === undefined ? "未设置" : JSON.stringify(value);
    return [`${labels[key] ?? key}：${format(oldValue)} → ${format(newValue)}`];
  });
}

import type { MappingExpression } from "@state-hub/protocol";
import type { FieldProps } from "@rjsf/utils";
import { useState } from "react";

function ConstantInput({ name, value, disabled, onChange }: {
  name: string; value: unknown; disabled: boolean; onChange(value: unknown): void;
}) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  return <label>常量 {name}
    <textarea aria-label={`常量 ${name}`} value={text} disabled={disabled} onChange={(event) => {
      const raw = event.target.value;
      setText(raw);
      try { onChange(JSON.parse(raw) as unknown); setInvalid(false); }
      catch { onChange(undefined); setInvalid(true); }
    }} />
    {invalid && <span role="alert">常量必须是有效 JSON</span>}
  </label>;
}

export function MappingField({ formData, onChange, fieldPathId, disabled, readonly }: FieldProps) {
  const mapping = (formData ?? {}) as Record<string, MappingExpression>;
  const [newKey, setNewKey] = useState("");
  const update = (name: string, expression: MappingExpression) =>
    onChange({ ...mapping, [name]: expression }, fieldPathId.path);
  return <fieldset className="mapping-field">
    <legend>动作映射</legend>
    {Object.entries(mapping).map(([name, expression]) => <div key={name} className="mapping-entry">
      <strong>{name}</strong>
      <label>映射类型 {name}
        <select aria-label={`映射类型 ${name}`} value={expression.kind} disabled={disabled || readonly}
          onChange={(event) => {
            const kind = event.target.value;
            update(name, kind === "pointer" ? { kind, pointer: "" } :
              kind === "template" ? { kind, template: "" } : { kind: "constant", value: "" });
          }}>
          <option value="constant">常量</option>
          <option value="pointer">JSON Pointer</option>
          <option value="template">模板</option>
        </select>
      </label>
      {expression.kind === "constant"
        ? <ConstantInput key={name} name={name} value={expression.value} disabled={!!disabled || !!readonly}
          onChange={(value) => update(name, { kind: "constant", value })} />
        : <label>{expression.kind === "pointer" ? "JSON Pointer" : "模板"} {name}
            <input aria-label={`${expression.kind} ${name}`}
              value={expression.kind === "pointer" ? expression.pointer : expression.template}
              disabled={disabled || readonly}
              onChange={(event) => update(name, expression.kind === "pointer"
                ? { kind: "pointer", pointer: event.target.value }
                : { kind: "template", template: event.target.value })} />
          </label>}
      <button type="button" disabled={disabled || readonly} onClick={() => {
        const next = { ...mapping };
        delete next[name];
        onChange(next, fieldPathId.path);
      }}>移除映射 {name}</button>
    </div>)}
    <label>参数名
      <input aria-label="新映射参数名" value={newKey} disabled={disabled || readonly} onChange={(event) => setNewKey(event.target.value)} />
    </label>
    <button type="button" disabled={disabled || readonly || !newKey || Object.hasOwn(mapping, newKey)}
      onClick={() => { update(newKey, { kind: "constant", value: "" }); setNewKey(""); }}>
      添加映射
    </button>
  </fieldset>;
}

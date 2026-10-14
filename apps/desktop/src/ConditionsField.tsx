import type { BindingCondition, ConditionOperator } from "@state-hub/protocol";
import type { FieldProps } from "@rjsf/utils";
import { useRef, useState } from "react";

const operators: ConditionOperator[] = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"];

function ConditionValueInput({ index, value, disabled, onChange, onValidityChange }: {
  index: number; value: unknown; disabled: boolean;
  onChange(value: unknown): void; onValidityChange(index: number, invalid: boolean): void;
}) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  return <label>比较值 {index + 1}
    <textarea aria-label={`比较值 ${index + 1}`} disabled={disabled} value={text}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        try {
          onChange(JSON.parse(raw) as unknown);
          setInvalid(false);
          onValidityChange(index, false);
        } catch {
          setInvalid(true);
          onValidityChange(index, true);
        }
      }} />
    {invalid && <span role="alert">比较值必须是有效 JSON</span>}
  </label>;
}

export function ConditionsField({ formData, onChange, fieldPathId, disabled, readonly,
  registry }: FieldProps) {
  const conditions = (formData ?? []) as BindingCondition[];
  const sequence = useRef(0);
  const keys = useRef<number[]>([]);
  while (keys.current.length < conditions.length) keys.current.push(++sequence.current);
  if (keys.current.length > conditions.length) keys.current.length = conditions.length;
  const setInvalid = (registry.formContext as {
    onConditionsValidityChange?: (index: number, invalid: boolean, removed?: boolean) => void;
  } | undefined)?.onConditionsValidityChange;
  const update = (index: number, condition: BindingCondition) =>
    onChange(conditions.map((entry, position) => position === index ? condition : entry), fieldPathId.path);
  return <fieldset className="mapping-field">
    <legend>条件</legend>
    {conditions.map((condition, index) => <div key={keys.current[index]} className="mapping-entry">
      <label>JSON Pointer {index + 1}
        <input aria-label={`条件指针 ${index + 1}`} value={condition.pointer}
          disabled={disabled || readonly}
          onChange={(event) => update(index, { ...condition, pointer: event.target.value })} />
      </label>
      <label>运算符 {index + 1}
        <select aria-label={`条件运算符 ${index + 1}`} value={condition.operator}
          disabled={disabled || readonly}
          onChange={(event) => {
            const operator = event.target.value as ConditionOperator;
            update(index, { ...condition, operator });
            if (operator === "exists") setInvalid?.(index, false);
          }}>
          {operators.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
        </select>
      </label>
      {condition.operator !== "exists" && <ConditionValueInput index={index} value={condition.value}
        disabled={!!disabled || !!readonly}
        onChange={(value) => update(index, { ...condition, value })}
        onValidityChange={(position, invalid) => setInvalid?.(position, invalid)} />}
      <button type="button" disabled={disabled || readonly} onClick={() => {
        keys.current.splice(index, 1);
        onChange(conditions.filter((_, position) => position !== index), fieldPathId.path);
        setInvalid?.(index, false, true);
      }}>移除条件 {index + 1}</button>
    </div>)}
    <button type="button" disabled={disabled || readonly} onClick={() =>
      onChange([...conditions, { pointer: "", operator: "eq", value: null }], fieldPathId.path)}>
      添加条件
    </button>
  </fieldset>;
}

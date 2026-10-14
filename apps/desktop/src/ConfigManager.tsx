import { Alert, Button, Empty, Modal, Space, Switch, Table, Tag } from "antd";
import Form from "@rjsf/antd";
import { customizeValidator } from "@rjsf/validator-ajv8";
import type { ObjectFieldTemplateProps } from "@rjsf/utils";
import type { Binding } from "@state-hub/protocol";
import { useEffect, useRef, useState } from "react";
import {
  loadConfigCatalog, loadConfigRevisions, loadManagedConfig, previewManagedConfig,
  previewRollback, publishManagedConfig,
  type ConfigCatalog, type ConfigInstance, type ConfigPreview, type ConfigRevision, type ManagedConfig,
} from "./config-management.js";
import { applyOperation, operationChanges, operationSummary, sameConfigValue, type ConfigOperation } from "./config-operations.js";
import { bindingSchema, instanceSchema, newBinding } from "./config-forms.js";
import { mergeCodexVirtual } from "./api.js";
import { listProducers, secretExists } from "./management.js";
import { MappingField } from "./MappingField.js";
import { ConditionsField } from "./ConditionsField.js";
import { CredentialManager } from "./CredentialManager.js";

const validator = customizeValidator({ ajvOptionsOverrides: { strict: false },
  customFormats: { "statehub-secret-ref": /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u } });
export type ConfigSection = "outputs" | "rules" | "versions";
type OutputEditor = { session: number; original: ConfigInstance | undefined; value: ConfigInstance };
type RuleEditor = { session: number; original: Binding | undefined; value: Binding; targets: ConfigInstance[] };
type Review = { preview: ConfigPreview; base: ManagedConfig; summary: string; changes: string[]; kind: ConfigSection; output?: ConfigInstance };
const empty: ManagedConfig = { driverInstances: [], bindings: [] };
const errorLabels: Record<string, string> = {
  EDIT_CONFLICT: "此项目已被其他操作修改。请保留需要的内容，放弃本次编辑后重新打开最新版本。",
  OUTPUT_CHANGED: "目标输出已变化，请重新选择并审阅规则。",
  OUTPUT_IN_USE: "该输出仍被规则引用，请先调整或移除关联规则。",
  CONFIG_CHANGED_RELOAD: "配置已变化，旧预览已失效。编辑内容保留，请重新审阅。",
  CONFIG_STALE_DRAFT: "配置版本已变化，请重新审阅本次修改。",
  CREDENTIAL_MISSING: "所需密钥尚未保存，请先完成凭据设置。",
};

function RuleLayout(props: ObjectFieldTemplateProps) {
  const advanced = useRef<HTMLDetailsElement>(null);
  const errorGeneration = props.registry.formContext?.errorGeneration as number | undefined;
  useEffect(() => { if (errorGeneration && advanced.current) advanced.current.open = true; }, [errorGeneration]);
  if (props.fieldPathId.path.length > 0) return <fieldset>{props.title && <legend>{props.title}</legend>}
    {props.description}{props.properties.map((item) => item.content)}</fieldset>;
  const group = (names: string[]) => props.properties.filter((item) => names.includes(item.name)).map((item) => item.content);
  return <>
    <section className="form-section"><h3>规则名称</h3>{group(["id", "name", "enabled"])}</section>
    <section className="form-section"><h3>触发条件</h3><p>选择关注的来源和信号；条件全部满足时触发。留空的筛选项表示不限制。</p>{group(["selector", "conditions"])}</section>
    <section className="form-section"><h3>执行动作</h3><p>选择已生效的输出，将输入字段映射为输出内容。例如 /content 表示消息中的 content 字段。</p>{group(["target", "mapping"])}</section>
    <details ref={advanced} className="form-section"><summary>高级选项：优先级、确认与批处理</summary>
      <p>同一输出通道竞争时按紧急度、规则顺序和状态版本取舍。“尊重确认”仅停止对已确认版本的提醒。</p>
      {group(["urgencyOverride", "order", "honorAcknowledgement", "transitionOnly", "batchWindowMs"])}</details>
  </>;
}

export function ConfigManager({ disabled, onPublished, section = "outputs", active = true, onNavigate, onDirtyChange }: {
  disabled: boolean; onPublished(): void; section?: ConfigSection; active?: boolean;
  onNavigate?(section: ConfigSection): void; onDirtyChange?(output: boolean, rule: boolean): void;
}) {
  const [modal, modalContext] = Modal.useModal();
  const [catalog, setCatalog] = useState<ConfigCatalog>();
  const [config, setConfig] = useState<ManagedConfig>(empty);
  const [revisions, setRevisions] = useState<ConfigRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<ConfigRevision>();
  const [outputEditor, setOutputEditor] = useState<OutputEditor>();
  const [ruleEditor, setRuleEditor] = useState<RuleEditor>();
  const [invalidConditions, setInvalidConditions] = useState<Set<number>>(new Set());
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [nextOutput, setNextOutput] = useState<ConfigInstance>();
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [errorGeneration, setErrorGeneration] = useState(0);
  const epoch = useRef(0);
  const loadSequence = useRef(0);
  const editorSequence = useRef(0);
  const inFlight = useRef(false);

  const refresh = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const [nextCatalog, nextConfig, nextRevisions] = await Promise.all([
        loadConfigCatalog(), loadManagedConfig(), loadConfigRevisions(),
      ]);
      if (sequence !== loadSequence.current) return;
      setCatalog(nextCatalog); setConfig(nextConfig); setRevisions(nextRevisions); setLoaded(true);
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  };
  useEffect(() => {
    epoch.current += 1;
    const sequence = ++loadSequence.current;
    setReview(undefined);
    setSelectedRevision(undefined);
    setCredentialOpen(false);
    if (disabled || !active) { setLoading(false); return; }
    setLoading(true);
    let mounted = true;
    void Promise.all([loadConfigCatalog(), loadManagedConfig(), loadConfigRevisions()])
      .then(([nextCatalog, nextConfig, nextRevisions]) => {
        if (!mounted || sequence !== loadSequence.current) return;
        setCatalog(nextCatalog); setConfig(nextConfig); setRevisions(nextRevisions);
        setLoaded(true); setError(undefined);
      }).catch(() => { if (mounted && sequence === loadSequence.current) setError("CONFIG_READ_FAILED"); })
      .finally(() => { if (mounted && sequence === loadSequence.current) setLoading(false); });
    return () => { mounted = false; };
  }, [disabled, active, section]);
  useEffect(() => { onDirtyChange?.(!!outputEditor, !!ruleEditor); }, [outputEditor, ruleEditor, onDirtyChange]);
  const run = async (task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await task(); }
    catch (reason) {
      setReview(undefined);
      setError(reason instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(reason.message) ? reason.message : "CONFIG_OPERATION_FAILED");
    } finally { setBusy(false); inFlight.current = false; }
  };
  const invalidate = () => { epoch.current += 1; setReview(undefined); };
  const beginOutput = (value?: ConfigInstance, original = config.driverInstances.find((item) => item.id === value?.id)) => {
    const open = () => { invalidate(); setOutputEditor({ session: ++editorSequence.current, original, value: structuredClone(value ?? {
      id: "", driverType: catalog?.driverDefinitions[0]?.id ?? "", enabled: true, config: {},
    }) }); };
    if (outputEditor) modal.confirm({ title: "已有未保存的输出编辑", content: "放弃后才能编辑另一项；保留可继续原编辑。",
      okText: "放弃并继续", cancelText: "保留编辑", onOk: open });
    else open();
  };
  const beginRule = (value?: Binding, original = config.bindings.find((item) => item.id === value?.id)) => {
    const open = () => { invalidate(); setInvalidConditions(new Set()); setErrorGeneration(0); setRuleEditor({ session: ++editorSequence.current, original,
      value: structuredClone(value ?? newBinding(config.driverInstances, catalog?.driverDefinitions ?? [])),
      targets: structuredClone(config.driverInstances) }); onNavigate?.("rules"); };
    if (ruleEditor) modal.confirm({ title: "已有未保存的规则编辑", content: "放弃后才能编辑另一项；保留可继续原编辑。",
      okText: "放弃并继续", cancelText: "保留编辑", onOk: open });
    else open();
  };
  const preview = async (operation: ConfigOperation) => {
    const generation = ++epoch.current;
    setReview(undefined);
    const base = await loadManagedConfig();
    const candidate = applyOperation(base, operation);
    if (operation.kind === "output" && operation.after && ["pushplus", "official.pushplus"].includes(operation.after.driverType)) {
      if (!await secretExists(String(operation.after.config.tokenSecretRef ?? ""))) throw new Error("CREDENTIAL_MISSING");
    }
    const result = await previewManagedConfig(candidate);
    if (!sameConfigValue(base, await loadManagedConfig())) throw new Error("CONFIG_CHANGED_RELOAD");
    if (generation !== epoch.current) return;
    setConfig(base);
    setReview({ preview: result, base, summary: operationSummary(operation), changes: operationChanges(operation),
      kind: operation.kind === "output" ? "outputs" : "rules",
      ...(operation.kind === "output" && operation.after ? { output: operation.after } : {}) });
  };
  const submitOutput = (value: ConfigInstance) => preview({ kind: "output", id: outputEditor?.original?.id ?? value.id,
    before: outputEditor?.original, after: value });
  const submitRule = (value: Binding) => preview({ kind: "rule", id: ruleEditor?.original?.id ?? value.id,
    before: ruleEditor?.original, after: value,
    dependency: ruleEditor?.targets.find((item) => item.id === value.target.driverInstanceId) });
  const continueRule = async (output: ConfigInstance) => {
    let value = newBinding([output], catalog?.driverDefinitions ?? []);
    if (["virtual", "official.virtual"].includes(output.driverType) && output.id === "virtual-main") {
      const producers = await listProducers();
      if (producers.some((item) => item.producerId === "codex" && !item.revokedAt)) {
        value = mergeCodexVirtual({ driverInstances: [output], bindings: [] }).bindings[0]!;
      }
    }
    if (["pushplus", "official.pushplus"].includes(output.driverType)) {
      value = { ...value, id: `pushplus:${output.id}`, name: "PushPlus 通知", selector: { eventType: "custom", scopePattern: "*" },
        mapping: { content: { kind: "pointer", pointer: "/content" } },
        target: { driverInstanceId: output.id, resourceChannel: "messages", actionKind: "append-only", actionName: "send" } };
    }
    const existing = config.bindings.find((item) => item.id === value.id);
    if (existing && existing.target.driverInstanceId !== output.id) throw new Error("BINDING_ID_CONFLICT");
    beginRule(existing ?? value, existing);
  };

  const locked = disabled || busy || loading || !catalog;
  const targetNames = config.driverInstances.map((item) => item.id).join("、");
  return <div className="config-manager">
    {modalContext}
    {loading && <p role="status">正在读取已生效的配置…</p>}
    {error && <Alert type="error" showIcon role="alert" message={errorLabels[error] ?? "配置操作未完成，请检查输入和连接。"} description={error} />}
    {error === "CONFIG_READ_FAILED" && <Button disabled={disabled || busy} onClick={() => void run(refresh)}>重新读取配置</Button>}
    {notice && <Alert type="success" showIcon message={notice} />}
    <div hidden={section !== "outputs"}>
      <div className="section-toolbar"><span>独立配置设备或服务，稍后再关联规则。</span><Space wrap>
        <Button disabled={locked} onClick={() => beginOutput()}>新增输出</Button>
        <Button disabled={locked} onClick={() => {
          const existing = config.driverInstances.find((item) => item.id === "virtual-main");
          if (existing && !["virtual", "official.virtual"].includes(existing.driverType)) { setError("VIRTUAL_INSTANCE_ID_CONFLICT"); return; }
          if (existing) { beginOutput(existing); return; }
          beginOutput({ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }, undefined);
        }}>虚拟输出引导</Button>
        <Button disabled={locked} onClick={() => {
          const existing = config.driverInstances.find((item) => item.id === "pushplus-main");
          if (existing && !["pushplus", "official.pushplus"].includes(existing.driverType)) { setError("DRIVER_INSTANCE_ID_CONFLICT"); return; }
          if (existing) { beginOutput(existing); return; }
          beginOutput({ id: "pushplus-main", driverType: "pushplus", enabled: true, config: { tokenSecretRef: "pushplus:main" } }, undefined);
        }}>PushPlus 引导</Button>
      </Space></div>
      {!outputEditor ? <Table loading={loading} rowKey="id" size="small" dataSource={config.driverInstances} pagination={{ pageSize: 12 }}
        locale={{ emptyText: <Empty description={loaded ? "尚未配置输出。可以先添加虚拟输出验证规则。" : "配置尚未读取成功"} /> }}
        columns={[
          { title: "输出", dataIndex: "id", render: (id: string, item: ConfigInstance) => <div><strong>{id}</strong><div className="muted">{item.driverType}</div></div> },
          { title: "关联规则", render: (_, item) => { const count = config.bindings.filter((rule) => rule.target.driverInstanceId === item.id).length;
            return <Tag>{count ? `${count} 条规则` : "未关联规则"}</Tag>; } },
          { title: "配置启用", render: (_, item) => <Switch aria-label={`启用输出 ${item.id}`} checked={item.enabled} disabled={locked}
            onChange={(enabled) => void run(() => preview({ kind: "output", id: item.id, before: item, after: { ...item, enabled } }))} /> },
          { title: "操作", render: (_, item) => <Space wrap>
            <Button size="small" disabled={locked} onClick={() => beginOutput(item)}>编辑输出</Button>
            <Button size="small" disabled={locked} onClick={() => void run(() => continueRule(item))}>添加规则</Button>
            <Button size="small" danger disabled={locked} onClick={() => {
              const related = config.bindings.filter((rule) => rule.target.driverInstanceId === item.id);
              if (related.length) { modal.info({ title: "先处理关联规则", content: related.map((rule) => rule.name || rule.id).join("、"), okText: "知道了" }); return; }
              void run(() => preview({ kind: "output", id: item.id, before: item, after: undefined }));
            }}>移除输出</Button>
          </Space> },
        ]} /> : <div className="editor-view">
        <div className="section-toolbar"><h3>{outputEditor.original ? "编辑输出" : "新增输出"} <Tag color="gold">未保存</Tag></h3>
          <Button disabled={busy} onClick={() => { invalidate(); setOutputEditor(undefined); }}>放弃本次编辑</Button></div>
        <p className="muted">这里只应用当前输出；没有关联规则也可以保存。切换栏目保留编辑，真正退出应用后不恢复。</p>
        {catalog && <Form key={`output-${outputEditor.session}`} idPrefix="output"
          schema={instanceSchema(catalog.driverDefinitions, outputEditor.value.driverType)} validator={validator}
          formData={outputEditor.value} disabled={locked} uiSchema={{ id: { "ui:readonly": !!outputEditor.original } }}
          onChange={(event) => { invalidate(); const value = event.formData as ConfigInstance;
            setOutputEditor({ ...outputEditor, value: value.driverType === outputEditor.value.driverType ? value : { ...value, config: {} } }); }}
          onSubmit={(event) => void run(() => submitOutput(event.formData as ConfigInstance))}
          onError={() => setError("INVALID_DRIVER_FORM")}>
          <Space wrap><Button type="primary" htmlType="submit" disabled={locked}>审阅本次输出修改</Button>
            <Button disabled={locked} onClick={() => setCredentialOpen(true)}>保存所需密钥（立即生效）</Button></Space>
        </Form>}
      </div>}
      {nextOutput && !outputEditor && <Alert className="next-step" type="success" showIcon message={`输出 ${nextOutput.id} 已生效`}
        description="可以到此结束，或继续为它添加联动规则。" action={<Button disabled={locked} onClick={() => void run(() => continueRule(nextOutput))}>继续添加规则</Button>} />}
    </div>
    <div hidden={section !== "rules"}>
      <div className="section-toolbar"><span>选择已生效的输出，设置何时触发以及执行什么动作。</span>
        <Button disabled={locked || !config.driverInstances.length} onClick={() => beginRule()}>新增规则</Button></div>
      {loaded && !config.driverInstances.length && <Alert type="info" message="先在输出栏添加一个输出，再为它配置规则。" />}
      {!ruleEditor ? <Table loading={loading} rowKey="id" size="small" dataSource={config.bindings} pagination={{ pageSize: 12 }}
        locale={{ emptyText: <Empty description={loaded ? "尚未配置规则。输出可以先独立存在。" : "配置尚未读取成功"} /> }} columns={[
          { title: "联动规则", render: (_, item) => <div><strong>{item.name || item.id}</strong><div className="muted">
            {item.selector.producerId || item.selector.sourceType || "任意来源"} → {item.conditions.length ? `${item.conditions.length} 个条件` : "匹配信号"} → {item.target.driverInstanceId}
          </div><small>{item.id}</small></div> },
          { title: "启用", render: (_, item) => <Switch aria-label={`启用规则 ${item.id}`} checked={item.enabled} disabled={locked}
            onChange={(enabled) => void run(() => preview({ kind: "rule", id: item.id, before: item, after: { ...item, enabled },
              dependency: config.driverInstances.find((output) => output.id === item.target.driverInstanceId) }))} /> },
          { title: "操作", render: (_, item) => <Space wrap><Button size="small" disabled={locked} onClick={() => beginRule(item)}>编辑规则</Button>
            <Button size="small" danger disabled={locked} onClick={() => void run(() => preview({ kind: "rule", id: item.id, before: item,
              after: undefined, dependency: undefined }))}>移除规则</Button></Space> },
        ]} /> : <div className="editor-view">
        <div className="section-toolbar"><h3>{ruleEditor.original ? "编辑规则" : "新增规则"} <Tag color="gold">未保存</Tag></h3>
          <Button disabled={busy} onClick={() => { invalidate(); setRuleEditor(undefined); }}>放弃本次编辑</Button></div>
        <p className="muted">仅应用这条规则。可用输出：{targetNames || "暂无"}。高级选项在下方展开。</p>
        {error === "OUTPUT_CHANGED" && <Button disabled={locked} onClick={() => void run(async () => {
          const current = await loadManagedConfig(); invalidate(); setConfig(current);
          setRuleEditor((editor) => editor ? { ...editor, targets: structuredClone(current.driverInstances) } : editor);
        })}>更新目标输出信息并保留规则编辑</Button>}
        {catalog && <Form key={`rule-${ruleEditor.session}`} idPrefix="rule"
          schema={bindingSchema(config.driverInstances, catalog.driverDefinitions, ruleEditor.value.target.driverInstanceId)}
          validator={validator} formData={ruleEditor.value} disabled={locked}
          templates={{ ObjectFieldTemplate: RuleLayout }}
          uiSchema={{ id: { "ui:readonly": !!ruleEditor.original }, conditions: { "ui:field": "ConditionsField" }, mapping: { "ui:field": "MappingField" } }}
          fields={{ MappingField, ConditionsField }}
          formContext={{ errorGeneration, onConditionsValidityChange: (index: number, invalid: boolean, removed = false) => {
            invalidate(); setInvalidConditions((current) => {
              const next = new Set<number>();
              for (const position of current) {
                if (position === index) { if (invalid && !removed) next.add(position); }
                else next.add(removed && position > index ? position - 1 : position);
              }
              if (invalid && !removed) next.add(index);
              return next;
            });
          } }}
          onChange={(event) => { invalidate(); let value = event.formData as Binding;
            if (value.target.driverInstanceId !== ruleEditor.value.target.driverInstanceId) {
              const target = config.driverInstances.find((item) => item.id === value.target.driverInstanceId);
              const defaults = newBinding(target ? [target] : [], catalog.driverDefinitions);
              value = { ...value, target: { ...defaults.target, resourceChannel: value.target.resourceChannel }, mapping: {} };
            }
            setRuleEditor({ ...ruleEditor, value, targets: value.target.driverInstanceId !== ruleEditor.value.target.driverInstanceId
              ? structuredClone(config.driverInstances) : ruleEditor.targets }); }}
          onSubmit={(event) => void run(() => submitRule(event.formData as Binding))}
          onError={() => { setError("INVALID_BINDING_FORM"); setErrorGeneration((value) => value + 1); }}>
          <Button type="primary" htmlType="submit" disabled={locked || invalidConditions.size > 0}>审阅本次规则修改</Button>
        </Form>}
      </div>}
    </div>
    <div hidden={section !== "versions"}>
      <Alert type="info" showIcon message="恢复版本会替换整套输出与规则，并创建新版本。来源授权与密钥不在回滚范围内。" />
      {(outputEditor || ruleEditor) && <Alert type="warning" message="存在未保存编辑。请先完成或放弃输出、规则编辑，再恢复版本。" />}
      <Table size="small" rowKey="revision" dataSource={revisions} pagination={false} columns={[
        { title: "版本", dataIndex: "revision", render: (value: number) => `#${value}` },
        { title: "状态", dataIndex: "status", render: (value: string) => ({ draft: "预览草案", published: "当前生效", superseded: "历史版本" })[value] ?? value },
        { title: "创建时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
        { title: "操作", render: (_, item) => <Space wrap><Button size="small" onClick={() => setSelectedRevision(item)}>查看版本</Button>
          <Button size="small" disabled={locked || !!outputEditor || !!ruleEditor || item.status === "draft"}
            onClick={() => void run(async () => {
              const generation = ++epoch.current; setReview(undefined);
              const base = await loadManagedConfig(); const result = await previewRollback(item.revision);
              if (!sameConfigValue(base, await loadManagedConfig())) throw new Error("CONFIG_CHANGED_RELOAD");
              if (generation === epoch.current) setReview({ preview: result, base, summary: `恢复整套配置到版本 #${item.revision}`,
                changes: ["替换全部输出与规则；来源授权与密钥保持现状。"], kind: "versions" });
            })}>回滚并预览</Button></Space> },
      ]} />
      {revisions.length > 0 && revisions.length % 50 === 0 && <Button disabled={locked} onClick={() => void run(async () => {
        setRevisions([...revisions, ...await loadConfigRevisions(revisions.at(-1)!.revision)]);
      })}>加载更早版本</Button>}
    </div>
    <Modal open={!!review && active} title="审阅本次修改" okText="应用本次修改" cancelText="返回编辑" confirmLoading={busy}
      okButtonProps={{ disabled: disabled || busy }} onCancel={() => { if (!busy) setReview(undefined); }}
      onOk={() => void run(async () => {
        if (!review) return;
        const generation = epoch.current;
        if (!sameConfigValue(review.base, await loadManagedConfig())) throw new Error("CONFIG_CHANGED_RELOAD");
        if (generation !== epoch.current) return;
        await publishManagedConfig(review.preview.revision);
        if (review.kind === "outputs") { setOutputEditor(undefined); setNextOutput(review.output); }
        if (review.kind === "rules") setRuleEditor(undefined);
        setReview(undefined); setNotice("本次修改已应用，其他未保存编辑没有提交。"); onPublished();
        await refresh();
      })}>
      <p><strong>{review?.summary}</strong></p><p>仅应用本次操作。已有运行状态将重新计算；历史事件不会重放。</p>
      <ul className="review-changes">{review?.changes.map((change) => <li key={change}>{change}</li>)}</ul>
      <p>Core 校验通过；预览版本 #{review?.preview.revision}</p>
      <details><summary>查看后端影响统计</summary><pre>{JSON.stringify(review?.preview.impact, null, 2)}</pre></details>
    </Modal>
    <Modal open={!!selectedRevision} title={`配置版本 #${selectedRevision?.revision}`} footer={null} onCancel={() => setSelectedRevision(undefined)}>
      <p>此处显示该版本的影响统计；恢复前需要另行预览。</p><pre>{JSON.stringify(selectedRevision?.impact, null, 2)}</pre>
    </Modal>
    <Modal open={credentialOpen} title="保存输出所需密钥" footer={null} destroyOnHidden onCancel={() => setCredentialOpen(false)}>
      {credentialOpen && <CredentialManager disabled={disabled}
        initialReference={String(outputEditor?.value.config.tokenSecretRef ?? "pushplus:main")}
        onSaved={(reference) => { if (outputEditor && ["pushplus", "official.pushplus"].includes(outputEditor.value.driverType)) {
          invalidate(); setOutputEditor((current) => current?.session === outputEditor.session ? { ...current,
            value: { ...current.value, config: { ...current.value.config, tokenSecretRef: reference } } } : current);
        } }} />}
    </Modal>
  </div>;
}

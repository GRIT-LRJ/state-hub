import { Button, Card, Space, Switch, Typography } from "antd";
import Form from "@rjsf/antd";
import { customizeValidator } from "@rjsf/validator-ajv8";
import type { Binding } from "@state-hub/protocol";
import { useEffect, useState } from "react";
import {
  loadConfigCatalog, loadConfigRevisions, loadManagedConfig, previewManagedConfig,
  previewRollback, publishManagedConfig, putBinding, putInstance,
  type ConfigCatalog, type ConfigInstance, type ConfigPreview, type ConfigRevision, type ManagedConfig,
} from "./config-management.js";
import { bindingSchema, instanceSchema, newBinding } from "./config-forms.js";
import { MappingField } from "./MappingField.js";
import { ConditionsField } from "./ConditionsField.js";

const validator = customizeValidator({
  ajvOptionsOverrides: { strict: false },
  customFormats: { "statehub-secret-ref": /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u },
});

type Editor =
  | { kind: "instance"; originalId?: string | undefined; value: ConfigInstance }
  | { kind: "binding"; originalId?: string | undefined; value: Binding };

function safeError(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message)
    ? error.message : "CONFIG_OPERATION_FAILED";
}

export function ConfigManager({ disabled, onPublished }: { disabled: boolean; onPublished(): void }) {
  const [catalog, setCatalog] = useState<ConfigCatalog>();
  const [working, setWorking] = useState<ManagedConfig>();
  const [baseConfig, setBaseConfig] = useState<ManagedConfig>();
  const [revisions, setRevisions] = useState<ConfigRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<ConfigRevision>();
  const [editor, setEditor] = useState<Editor>();
  const [invalidConditionIndices, setInvalidConditionIndices] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<ConfigPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    const [nextCatalog, nextConfig, nextRevisions] = await Promise.all([
      loadConfigCatalog(), loadManagedConfig(), loadConfigRevisions(),
    ]);
    setCatalog(nextCatalog);
    setWorking(nextConfig);
    setBaseConfig(nextConfig);
    setRevisions(nextRevisions);
    setSelectedRevision(undefined);
  };
  useEffect(() => {
    if (disabled) { setPreview(undefined); return; }
    let active = true;
    void Promise.all([loadConfigCatalog(), loadManagedConfig(), loadConfigRevisions()])
      .then(([nextCatalog, nextConfig, nextRevisions]) => {
        if (!active) return;
        setCatalog(nextCatalog);
        setWorking(nextConfig);
        setBaseConfig(nextConfig);
        setRevisions(nextRevisions);
      }).catch(() => { if (active) setError("CONFIG_READ_FAILED"); });
    return () => { active = false; };
  }, [disabled]);

  const assertCurrentBase = async () => {
    if (!baseConfig || JSON.stringify(await loadManagedConfig()) !== JSON.stringify(baseConfig)) {
      throw new Error("CONFIG_CHANGED_RELOAD");
    }
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await work(); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  };
  const editWorking = (next: ManagedConfig) => {
    setWorking(next);
    setPreview(undefined);
    setEditor(undefined);
  };
  const beginInstance = (instance?: ConfigInstance) => {
    setPreview(undefined);
    setEditor({ kind: "instance", originalId: instance?.id,
      value: instance ?? { id: "", driverType: catalog?.driverDefinitions[0]?.id ?? "", enabled: true, config: {} } });
  };
  const beginBinding = (binding?: Binding) => {
    setPreview(undefined);
    setInvalidConditionIndices(new Set());
    setEditor({ kind: "binding", originalId: binding?.id,
      value: binding ?? newBinding(working?.driverInstances ?? [], catalog?.driverDefinitions ?? []) });
  };
  const stageInstance = (instance: ConfigInstance, originalId?: string) => {
    if (!working) return;
    editWorking(putInstance(working, instance, originalId));
  };
  const stageBinding = (binding: Binding, originalId?: string) => {
    if (!working) return;
    editWorking(putBinding(working, binding, originalId));
    setInvalidConditionIndices(new Set());
  };
  const editInstance = editor?.kind === "instance" ? editor : undefined;
  const editBinding = editor?.kind === "binding" ? editor : undefined;

  return (
    <Card title="驱动、绑定与配置版本" className="config-manager">
      {error && <Typography.Text role="alert" type="danger">配置操作失败：{error}</Typography.Text>}
      <Typography.Paragraph type="secondary">
        更改先保存在本页面；Core 完整校验并展示影响后才可发布。密钥字段只填写系统凭据引用。
      </Typography.Paragraph>
      <Typography.Title level={5}>驱动实例</Typography.Title>
      <Space direction="vertical" className="management-form">
        {(working?.driverInstances ?? []).map((instance) => <Space key={instance.id}>
          <Typography.Text>{instance.id} · {instance.driverType}</Typography.Text>
          <Switch checked={instance.enabled} disabled={disabled || busy}
            aria-label={`启用驱动 ${instance.id}`}
            onChange={(enabled) => stageInstance({ ...instance, enabled }, instance.id)} />
          <Button disabled={disabled || busy} onClick={() => beginInstance(instance)}>编辑驱动</Button>
          <Button danger disabled={disabled || busy} onClick={() => {
            if (!working) return;
            editWorking({ ...working, driverInstances: working.driverInstances.filter((entry) => entry.id !== instance.id) });
          }}>移除驱动</Button>
        </Space>)}
        <Button disabled={disabled || busy || !catalog?.driverDefinitions.length}
          onClick={() => beginInstance()}>新增驱动</Button>
      </Space>
      {editInstance && catalog && <Form key={editInstance.originalId ?? "new-instance"}
        schema={instanceSchema(catalog.driverDefinitions, editInstance.value.driverType)}
        validator={validator} formData={editInstance.value} disabled={disabled || busy}
        {...(editInstance.originalId ? { uiSchema: { id: { "ui:readonly": true } } } : {})}
        onChange={(event) => {
          const next = event.formData as ConfigInstance;
          setEditor({ ...editInstance, value: next.driverType === editInstance.value.driverType
            ? next : { ...next, config: {} } });
        }}
        onSubmit={(event) => run(async () => stageInstance(event.formData as ConfigInstance, editInstance.originalId))}
        onError={() => setError("INVALID_DRIVER_FORM")}>
        <Space><Button htmlType="submit" disabled={disabled || busy}>保存驱动到草案</Button>
          <Button onClick={() => setEditor(undefined)}>取消</Button></Space>
      </Form>}
      <Typography.Title level={5}>绑定</Typography.Title>
      <Space direction="vertical" className="management-form">
        {(working?.bindings ?? []).map((binding) => <Space key={binding.id}>
          <Typography.Text>{binding.id} · {binding.name}</Typography.Text>
          <Switch checked={binding.enabled} disabled={disabled || busy}
            aria-label={`启用绑定 ${binding.id}`}
            onChange={(enabled) => stageBinding({ ...binding, enabled }, binding.id)} />
          <Button disabled={disabled || busy} onClick={() => beginBinding(binding)}>编辑绑定</Button>
          <Button danger disabled={disabled || busy} onClick={() => {
            if (!working) return;
            editWorking({ ...working, bindings: working.bindings.filter((entry) => entry.id !== binding.id) });
          }}>移除绑定</Button>
        </Space>)}
        <Button disabled={disabled || busy || !working?.driverInstances.length}
          onClick={() => beginBinding()}>新增绑定</Button>
      </Space>
      {editBinding && working && catalog && <Form key={editBinding.originalId ?? "new-binding"}
        schema={bindingSchema(working.driverInstances, catalog.driverDefinitions,
          editBinding.value.target.driverInstanceId)}
        validator={validator} formData={editBinding.value} disabled={disabled || busy}
        uiSchema={{ conditions: { "ui:field": "ConditionsField" },
          mapping: { "ui:field": "MappingField" },
          ...(editBinding.originalId ? { id: { "ui:readonly": true } } : {}) }}
        fields={{ MappingField, ConditionsField }}
        formContext={{ onConditionsValidityChange: (index: number, invalid: boolean, removed = false) => {
          setInvalidConditionIndices((current) => {
            const next = new Set<number>();
            for (const position of current) {
              if (position === index) { if (invalid && !removed) next.add(position); }
              else next.add(removed && position > index ? position - 1 : position);
            }
            if (invalid && !removed) next.add(index);
            return next;
          });
        } }}
        onChange={(event) => setEditor({ ...editBinding, value: event.formData as Binding })}
        onSubmit={(event) => run(async () => stageBinding(event.formData as Binding, editBinding.originalId))}
        onError={() => setError("INVALID_BINDING_FORM")}>
        <Space><Button htmlType="submit" disabled={disabled || busy || invalidConditionIndices.size > 0}>保存绑定到草案</Button>
          <Button onClick={() => setEditor(undefined)}>取消</Button></Space>
      </Form>}
      <Space className="config-actions">
        <Button type="primary" disabled={disabled || busy || !working || !!editor}
          onClick={() => void run(async () => {
            if (!working) return;
            await assertCurrentBase();
            setPreview(await previewManagedConfig(working));
          })}>完整校验并预览影响</Button>
        <Button disabled={disabled || busy} onClick={() => void run(refresh)}>放弃本页更改</Button>
      </Space>
      {preview && <div className="management-preview">
        <Typography.Text role="status">Core 校验通过；草案版本 {preview.revision}
          {preview.rolledBackFrom !== undefined ? `，回滚自版本 ${preview.rolledBackFrom}` : ""}</Typography.Text>
        <pre>{JSON.stringify(preview.impact, null, 2)}</pre>
        <Space>
          <Button type="primary" disabled={disabled || busy} onClick={() => void run(async () => {
            await assertCurrentBase();
            await publishManagedConfig(preview.revision);
            setPreview(undefined);
            onPublished();
            await refresh();
          })}>发布草案</Button>
          <Button onClick={() => setPreview(undefined)}>取消预览</Button>
        </Space>
      </div>}
      <Typography.Title level={5}>配置版本</Typography.Title>
      <Space direction="vertical" className="management-form">
        {revisions.map((revision) => <Space key={revision.revision}>
          <Typography.Text>#{revision.revision} · {revision.status} · {revision.createdAt}</Typography.Text>
          <Button disabled={disabled || busy}
            onClick={() => setSelectedRevision(revision)}>查看版本</Button>
          <Button disabled={disabled || busy || revision.status === "draft"}
            onClick={() => void run(async () => {
              await assertCurrentBase();
              setPreview(await previewRollback(revision.revision));
            })}>回滚并预览</Button>
        </Space>)}
        {selectedRevision && <div className="management-preview">
          <Typography.Text>版本 #{selectedRevision.revision} · {selectedRevision.status}
            {selectedRevision.publishedAt ? ` · ${selectedRevision.publishedAt}` : ""}</Typography.Text>
          <pre>{JSON.stringify(selectedRevision.impact, null, 2)}</pre>
        </div>}
        {revisions.length > 0 && revisions.length % 50 === 0 &&
          <Button disabled={disabled || busy} onClick={() => void run(async () => {
            const older = await loadConfigRevisions(revisions[revisions.length - 1]!.revision);
            setRevisions([...revisions, ...older]);
          })}>加载更早版本</Button>}
      </Space>
    </Card>
  );
}

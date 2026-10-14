import { Alert, Button, Input, Modal, Select, Space, Table, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { issueProducerToken, listProducers, listSources, revokeProducerToken, saveSecret, secretExists,
  type ManagedProducer, type SourceOption } from "./management.js";

export function SourceManager({ disabled, onPublished, onContinue, active = true }: {
  disabled: boolean; onPublished(): void; onContinue?(): void; active?: boolean;
}) {
  const [modal, modalContext] = Modal.useModal();
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [producers, setProducers] = useState<ManagedProducer[]>([]);
  const [editing, setEditing] = useState(false);
  const [producerId, setProducerId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [token, setToken] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const available = useRef(!disabled && active);
  available.current = !disabled && active;
  const confirmation = useRef<ReturnType<typeof Modal.confirm> | undefined>(undefined);
  const confirm = (options: Parameters<typeof Modal.confirm>[0]) => { confirmation.current = modal.confirm(options); };
  useEffect(() => {
    if (disabled || !active) confirmation.current?.destroy();
    return () => { confirmation.current?.destroy(); };
  }, [disabled, active]);
  const refresh = async () => {
    const [catalog, entries] = await Promise.all([listSources(), listProducers()]);
    setSources(catalog); setProducers(entries); setSourceId((current) => current || catalog[0]?.id || ""); setLoaded(true);
  };
  useEffect(() => {
    if (disabled || !active) return;
    let mounted = true;
    setLoading(true);
    void Promise.all([listSources(), listProducers()]).then(([catalog, entries]) => {
      if (!mounted) return;
      setSources(catalog); setProducers(entries); setSourceId((current) => current || catalog[0]?.id || "");
      setLoaded(true); setError(undefined);
    }).catch(() => { if (mounted) setError("无法读取接入方，请检查本地服务连接。"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [disabled, active]);
  const run = async (work: () => Promise<void>) => {
    if (!available.current) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await work(); }
    catch (reason) { setError(reason instanceof Error && reason.message === "PRODUCER_EXISTS"
      ? "这个生产者 ID 已存在，没有更改旧凭证；请从列表明确选择轮换。"
      : "操作未完成，请检查输入、本地服务和系统凭据库。已完成的授权操作不会自动撤销。"); }
    finally { setBusy(false); }
  };
  const issue = async (id: string, definition: string, codex = false, createOnly = false) => {
    if (!available.current) return;
    const issued = await issueProducerToken(id, definition, createOnly);
    setToken(issued); // Keep the once-only token available even if storing or refreshing fails.
    if (codex) await saveSecret("producer:codex", issued);
    setEditing(false);
    setNotice(codex ? "Codex 接入凭据已准备。还需由 Codex hook 上报；可以继续配置输出。" : "接入凭证已生效，请在发送方配置此 Token。");
    onPublished(); await refresh();
  };
  const codexSetup = () => void run(async () => {
    const existing = (await listProducers()).find((item) => item.producerId === "codex");
    if (!available.current) return;
    if (existing) {
      if (existing.sourceDefinitionId !== "official.codex") {
        setError("codex 标识已被其他来源定义使用，请先检查该接入方。"); return;
      }
      if (!existing.revokedAt && await secretExists("producer:codex")) {
        setNotice("Codex 授权与本机凭据已存在，未轮换 Token。可继续配置输出；是否上报请查看概览。"); return;
      }
      if (!available.current) return;
      confirm({ title: "重新准备 Codex 凭据", content: "当前凭据缺失或授权已撤销。重新准备会轮换 Token，旧 Token 立即失效。",
        okText: "轮换并保存", cancelText: "保留现状", onOk: () => run(() => issue("codex", "official.codex", true)) });
      return;
    }
    await issue("codex", "official.codex", true, true);
  });
  return <div className="source-manager">
    {modalContext}
    {error && <Alert type="error" showIcon message={error} />}
    {error && <Button disabled={disabled || busy} onClick={() => void run(refresh)}>重新读取接入方</Button>}
    {notice && <Alert type="success" showIcon message={notice} action={onContinue && <Button onClick={onContinue}>继续配置输出</Button>} />}
    <div className="section-toolbar"><span>授权程序向本机报告状态和事件。凭证有效不代表来源在线。</span>
      <Space wrap><Button disabled={disabled || busy || loading || !loaded} onClick={() => setEditing(true)}>添加接入方</Button>
        <Button disabled={disabled || busy || loading || !loaded} onClick={codexSetup}>Codex 接入引导</Button></Space></div>
    {!editing ? <Table loading={loading} locale={{ emptyText: loaded ? "尚未添加接入方" : "接入方尚未读取成功" }} size="small" rowKey="producerId" dataSource={producers} pagination={{ pageSize: 12 }} columns={[
      { title: "接入方", dataIndex: "producerId" },
      { title: "来源定义", dataIndex: "sourceDefinitionId" },
      { title: "授权", render: (_, item) => <Tag color={item.revokedAt ? "default" : "green"}>{item.revokedAt ? "已撤销" : "凭证有效"}</Tag> },
      { title: "操作", render: (_, item) => <Space wrap>
        <Button size="small" disabled={disabled || busy || !item.sourceDefinitionId} onClick={() => confirm({
          title: `轮换 ${item.producerId} 的 Token？`, content: "旧 Token 将立即失效，需要更新发送方配置。",
          okText: "轮换 Token", cancelText: "保留", onOk: () => run(() => issue(item.producerId, item.sourceDefinitionId!, item.producerId === "codex" && item.sourceDefinitionId === "official.codex")),
        })}>轮换 Token</Button>
        {!item.revokedAt && <Button size="small" danger disabled={disabled || busy} onClick={() => confirm({
          title: `撤销 ${item.producerId} 的授权？`, content: "立即停止接受此凭证的新请求，已有输出配置保留。",
          okText: "撤销 Token", cancelText: "保留", onOk: () => run(async () => { await revokeProducerToken(item.producerId); await refresh(); onPublished(); }),
        })}>撤销 Token</Button>}
      </Space> },
    ]} /> : <div className="editor-view editor-form">
      <div className="section-toolbar"><h3>添加接入方</h3><Button disabled={busy} onClick={() => setEditing(false)}>返回列表</Button></div>
      <label>生产者 ID<Input aria-label="生产者 ID" value={producerId} disabled={disabled || busy} onChange={(event) => setProducerId(event.target.value)} /></label>
      <p className="muted">标识具体的发送方，例如 my-tool。同名凭证只能通过列表中的轮换操作更新。</p>
      <label>来源定义<Select aria-label="来源定义" value={sourceId} disabled={disabled || busy} onChange={setSourceId}
        options={sources.map((source) => ({ value: source.id, label: source.id }))} /></label>
      <p className="muted">来源定义约定可以报告哪些状态和事件。创建凭证后，还需要在发送方配置上报。</p>
      <Button type="primary" disabled={disabled || busy || !producerId.trim() || !sourceId} onClick={() => void run(async () => {
        if ((await listProducers()).some((item) => item.producerId === producerId.trim())) {
          setError("这个生产者 ID 已存在，请返回列表使用轮换操作。"); return;
        }
        await issue(producerId.trim(), sourceId, false, true);
      })}>创建 Token（立即生效）</Button>
    </div>}
    <Modal open={token !== undefined} title="保存接入 Token" closable={false} maskClosable={false} keyboard={false} destroyOnHidden
      footer={<Button type="primary" onClick={() => setToken(undefined)}>已保存，关闭</Button>}>
      <p>此 Token 只显示一次；关闭后不会再显示。授权已经生效。</p>
      <Input aria-label="新生产者 Token" readOnly value={token ?? ""} />
    </Modal>
  </div>;
}

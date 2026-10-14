import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { removeSecret, saveSecret, secretExists } from "./management.js";

export function CredentialManager({ disabled, initialReference = "pushplus:main", onSaved }: {
  disabled: boolean; initialReference?: string; onSaved?(reference: string): void;
}) {
  const [modal, modalContext] = Modal.useModal();
  const [reference, setReference] = useState(initialReference);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const canOperate = useRef(!disabled);
  canOperate.current = !disabled;
  const confirmation = useRef<ReturnType<typeof Modal.confirm> | undefined>(undefined);
  useEffect(() => { if (disabled) confirmation.current?.destroy(); return () => { confirmation.current?.destroy(); }; }, [disabled]);
  const run = async (task: () => Promise<void>) => {
    if (!canOperate.current) return;
    setBusy(true); setError(false); setStatus(undefined);
    try { await task(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="editor-form">
    {modalContext}
    <Typography.Paragraph type="secondary">密钥保存在系统凭据库，配置中仅使用引用名。保存、替换和删除立即生效；不会读回已保存的密钥。</Typography.Paragraph>
    {error && <Alert showIcon type="error" message="凭据操作失败，请检查系统凭据库；没有显示底层敏感错误。" />}
    {status && <Alert type="success" showIcon message={status} />}
    <label>凭据引用<Input aria-label="凭据引用" value={reference} disabled={disabled || busy}
      onChange={(event) => { setReference(event.target.value); setStatus(undefined); }} /></label>
    <Typography.Text type="secondary">例如 pushplus:main。这是密钥的名字，不是密钥本身。</Typography.Text>
    <label>密钥<Input.Password aria-label="密钥" autoComplete="new-password" value={secret}
      disabled={disabled || busy} onChange={(event) => setSecret(event.target.value)} /></label>
    <Space wrap>
      <Button type="primary" disabled={disabled || busy || !reference || !secret} onClick={() => void run(async () => {
        await saveSecret(reference, secret); setSecret(""); setStatus("密钥已保存并立即生效；输出配置需另外审阅并应用。"); onSaved?.(reference);
      })}>保存或替换密钥</Button>
      <Button disabled={disabled || busy || !reference} onClick={() => void run(async () => {
        setStatus(await secretExists(reference) ? "系统凭据库中存在此引用" : "系统凭据库中没有此引用");
      })}>检查是否存在</Button>
      <Button danger disabled={disabled || busy || !reference} onClick={() => { confirmation.current = modal.confirm({
        title: "删除这个密钥？", content: "依赖此引用的输出可能停止发送。删除立即生效，配置回滚不会恢复密钥。",
        okText: "删除密钥", cancelText: "保留", okButtonProps: { danger: true },
        onOk: () => run(async () => { await removeSecret(reference); setSecret(""); setStatus("密钥已删除；依赖此引用的输出需要重新配置凭据。"); }),
      }); }}>删除密钥</Button>
    </Space>
  </div>;
}

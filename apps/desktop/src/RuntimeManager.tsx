import { Alert, Button, Card, Popconfirm, Space, Table, Typography } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StateClaim } from "./api.js";
import {
  acknowledgeClaim, fetchSupportBundle, loadDiagnosticPreview, saveSupportBundle,
  type DiagnosticPreview,
} from "./runtime-management.js";

function safeError(reason: unknown): string {
  return reason instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(reason.message)
    ? reason.message : "RUNTIME_OPERATION_FAILED";
}

export function RuntimeManager({ claims, disabled, onChanged, view = "all" }: {
  claims: StateClaim[]; disabled: boolean; onChanged(): void; view?: "all" | "claims" | "support";
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<DiagnosticPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try { await operation(); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  };
  const confirmClaim = (claim: StateClaim) => void run(async () => {
    await acknowledgeClaim(claim);
    onChanged();
  });
  const canExport = preview && preview.files.length > 0 &&
    preview.files.every((file) => file.containsSecrets === false);
  return <Space direction="vertical" className="runtime-manager">
    {error && <Alert type="error" role="alert"
      message={t("runtimeFailed", { code: error })} />}
    {view !== "support" && <Card title={t("claims")} className="data-card">
      <Typography.Paragraph type="secondary">来源当前报告的事实，不是历史日志。确认只针对这一次状态；只有尊重确认的规则会停止提醒。</Typography.Paragraph>
      <Table rowKey={(row) => JSON.stringify([row.producerId, row.scopeId, row.signalId])}
        dataSource={claims} pagination={{ pageSize: 20 }}
        expandable={{ expandedRowRender: (claim) =>
          <pre aria-label={t("claimValue")}>{JSON.stringify(claim.value, null, 2)}</pre> }}
        size="small" scroll={{ x: 620 }} columns={[
          { title: t("producer"), dataIndex: "producerId" },
          { title: t("scope"), dataIndex: "scopeId" },
          { title: t("signal"), dataIndex: "signalId" },
          { title: t("claimRevision"), dataIndex: "revision" },
          { title: t("urgency"), dataIndex: "urgency",
            render: (value) => String(value ?? "ambient") },
          { title: t("updatedAt"), dataIndex: "updatedAt",
            render: (value) => new Date(String(value)).toLocaleString() },
          { title: t("acknowledge"), key: "acknowledge", render: (_, claim) =>
            <Popconfirm title={t("acknowledgeRevision", { revision: claim.revision })}
              description={JSON.stringify([claim.producerId, claim.scopeId, claim.signalId])}
              onConfirm={() => confirmClaim(claim)} okText={t("acknowledge")}
              cancelText={t("cancel")}>
              <Button disabled={disabled || busy}>{t("acknowledge")}</Button>
            </Popconfirm> },
        ]}
        locale={{ emptyText: t("noClaims") }} />
    </Card>}
    {view !== "claims" && <Card title={t("diagnostics")} className="data-card">
      <Typography.Paragraph>{t("diagnosticsNotice")}</Typography.Paragraph>
      <Button disabled={disabled || busy} onClick={() => void run(async () => {
        setPreview(undefined);
        setPreview(await loadDiagnosticPreview());
      })}>{t("previewSupportBundle")}</Button>
      {preview && <div className="management-preview">
        <Typography.Title level={5}>{t("supportFiles")}</Typography.Title>
        <ul>{preview.files.map((file) => <li key={file.name}>
          {file.name} — {file.containsSecrets ? t("mayContainSecrets") : t("redacted")}
        </li>)}</ul>
        <Typography.Title level={5}>{t("redactionSummary")}</Typography.Title>
        <ul>{preview.redaction.map((item) => <li key={item}>{item}</li>)}</ul>
        <Button disabled={disabled || busy || !canExport}
          onClick={() => void run(async () => {
            const bundle = await fetchSupportBundle();
            setSaved(await saveSupportBundle(bundle));
          })}>{t("exportSupportBundle")}</Button>
      </div>}
      {saved && <Typography.Text role="status">{t("supportSaved")}</Typography.Text>}
    </Card>}
  </Space>;
}

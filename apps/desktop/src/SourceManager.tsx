import { Button, Card, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  issueProducerToken, listProducers, listSources, preparePushPlus, publishConfig,
  removeSecret, revokeProducerToken, saveSecret, secretExists,
  type ManagedProducer, type PushPlusSetup, type SourceOption,
} from "./management.js";

interface Props {
  disabled: boolean;
  onPublished(): void;
}

export function SourceManager({ disabled, onPublished }: Props) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [producers, setProducers] = useState<ManagedProducer[]>([]);
  const [producerId, setProducerId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [issuedToken, setIssuedToken] = useState<string>();
  const [reference, setReference] = useState("pushplus:main");
  const [secretValue, setSecretValue] = useState("");
  const [secretPresent, setSecretPresent] = useState<boolean>();
  const [setup, setSetup] = useState<PushPlusSetup>({
    instanceId: "pushplus-main", producerId: "", eventType: "custom",
    contentPointer: "/content", tokenSecretRef: "pushplus:main",
  });
  const [draft, setDraft] = useState<{ revision: number; impact: Record<string, unknown> }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    const [catalog, entries] = await Promise.all([listSources(), listProducers()]);
    setSources(catalog);
    setProducers(entries);
    setSourceId((current) => current || catalog[0]?.id || "");
    setSetup((current) => ({ ...current,
      producerId: current.producerId || entries.find((entry) => !entry.revokedAt)?.producerId || "",
    }));
  };

  useEffect(() => {
    if (disabled) return;
    let active = true;
    void Promise.all([listSources(), listProducers()]).then(([catalog, entries]) => {
      if (!active) return;
      setSources(catalog);
      setProducers(entries);
      setSourceId((current) => current || catalog[0]?.id || "");
      setSetup((current) => ({ ...current,
        producerId: current.producerId || entries.find((entry) => !entry.revokedAt)?.producerId || "",
      }));
    }).catch(() => { if (active) setError(t("managementFailed")); });
    return () => { active = false; };
  }, [disabled, t]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await work(); }
    catch { setError(t("managementFailed")); }
    finally { setBusy(false); }
  };

  const activeProducers = producers.filter((entry) => !entry.revokedAt);
  const changeSetup = (patch: Partial<PushPlusSetup>) => {
    setSetup((current) => ({ ...current, ...patch }));
    setDraft(undefined);
  };

  return (
    <Space direction="vertical" size="middle" className="management-panels">
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      <Card title={t("sourceManagement")}>
        <Space direction="vertical" className="management-form">
          <label>{t("producerId")}
            <input value={producerId} onChange={(event) => setProducerId(event.target.value)} disabled={disabled || busy} />
          </label>
          <label>{t("sourceDefinition")}
            <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={disabled || busy}>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.id}</option>)}
            </select>
          </label>
          <Button disabled={disabled || busy || !producerId || !sourceId}
            onClick={() => void run(async () => {
              const token = await issueProducerToken(producerId, sourceId);
              setIssuedToken(token);
              await refresh();
            })}>{t("createOrRotateToken")}</Button>
          {issuedToken && <div role="status" className="issued-token">
            <Typography.Text>{t("tokenShownOnce")}</Typography.Text>
            <input aria-label={t("issuedToken")} readOnly value={issuedToken} />
            <Button onClick={() => setIssuedToken(undefined)}>{t("dismissToken")}</Button>
          </div>}
          <div className="managed-producers">
            {producers.map((producer) => <div key={producer.producerId}>
              <span>{producer.producerId} · {producer.sourceDefinitionId ?? t("untypedSource")} · {producer.revokedAt ? t("revoked") : t("active")}</span>
              {!producer.revokedAt && <Button danger size="small" disabled={disabled || busy}
                onClick={() => void run(async () => {
                  await revokeProducerToken(producer.producerId);
                  setDraft(undefined);
                  await refresh();
                })}>{t("revokeToken")}</Button>}
            </div>)}
          </div>
        </Space>
      </Card>
      <Card title={t("credentialManagement")}>
        <Space direction="vertical" className="management-form">
          <label>{t("credentialReference")}
            <input value={reference} onChange={(event) => { setReference(event.target.value); setSecretPresent(undefined); }}
              disabled={disabled || busy} />
          </label>
          <label>{t("secretValue")}
            <input type="password" autoComplete="new-password" value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)} disabled={disabled || busy} />
          </label>
          <Space>
            <Button disabled={disabled || busy || !reference || !secretValue}
              onClick={() => void run(async () => {
                await saveSecret(reference, secretValue);
                setSecretValue("");
                setSecretPresent(true);
              })}>{t("saveOrReplaceSecret")}</Button>
            <Button disabled={disabled || busy || !reference}
              onClick={() => void run(async () => { setSecretPresent(await secretExists(reference)); })}>
              {t("checkSecret")}</Button>
            <Button danger disabled={disabled || busy || !reference}
              onClick={() => void run(async () => {
                await removeSecret(reference);
                setSecretValue("");
                setSecretPresent(false);
                setDraft(undefined);
              })}>{t("deleteSecret")}</Button>
          </Space>
          {secretPresent !== undefined && <Typography.Text role="status">
            {secretPresent ? t("secretPresent") : t("secretMissing")}
          </Typography.Text>}
          <Typography.Text type="secondary">{t("secretStorageNotice")}</Typography.Text>
        </Space>
      </Card>
      <Card title={t("pushPlusSetup")}>
        <Space direction="vertical" className="management-form">
          <label>{t("driverInstanceId")}
            <input value={setup.instanceId} onChange={(event) => changeSetup({ instanceId: event.target.value })}
              disabled={disabled || busy} />
          </label>
          <label>{t("producerId")}
            <select value={setup.producerId} onChange={(event) => changeSetup({ producerId: event.target.value })}
              disabled={disabled || busy}>
              <option value="">{t("selectProducer")}</option>
              {activeProducers.map((producer) => <option key={producer.producerId} value={producer.producerId}>
                {producer.producerId}</option>)}
            </select>
          </label>
          <label>{t("eventType")}
            <input value={setup.eventType} onChange={(event) => changeSetup({ eventType: event.target.value })}
              disabled={disabled || busy} />
          </label>
          <label>{t("contentPointer")}
            <input value={setup.contentPointer} onChange={(event) => changeSetup({ contentPointer: event.target.value })}
              disabled={disabled || busy} />
          </label>
          <label>{t("credentialReference")}
            <input value={setup.tokenSecretRef} onChange={(event) => changeSetup({ tokenSecretRef: event.target.value })}
              disabled={disabled || busy} />
          </label>
          <label>{t("pushPlusTopic")}
            <input value={setup.topic ?? ""} onChange={(event) => changeSetup({ topic: event.target.value })}
              disabled={disabled || busy} />
          </label>
          <Button disabled={disabled || busy || !setup.instanceId || !setup.producerId ||
            !setup.eventType || !setup.contentPointer || !setup.tokenSecretRef}
            onClick={() => void run(async () => { setDraft(await preparePushPlus(setup)); })}>
            {t("previewPushPlus")}</Button>
          {draft && <div className="management-preview">
            <Typography.Text>{t("previewTitle")}</Typography.Text>
            <pre>{JSON.stringify(draft.impact, null, 2)}</pre>
            <Space>
              <Button type="primary" disabled={disabled || busy}
                onClick={() => void run(async () => {
                  await publishConfig(draft.revision);
                  setDraft(undefined);
                  onPublished();
                })}>{t("publish")}</Button>
              <Button onClick={() => setDraft(undefined)}>{t("cancelPreview")}</Button>
            </Space>
          </div>}
        </Space>
      </Card>
    </Space>
  );
}

import {
  ApiOutlined,
  BellOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, ConfigProvider, Empty, Flex, Layout, Modal, Space, Statistic, Table, Tag, Typography, message, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchSnapshot, provisionCodexVirtual, publishConfig, setOutputsPaused, subscribe, type RuntimeSnapshot } from "./api.js";
import "./app.css";

const { Header, Content, Footer } = Layout;

export default function App() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchSnapshot());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const controller = new AbortController();
    void subscribe(() => void refresh(), controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    const fallback = setInterval(() => void refresh(), 5_000);
    return () => {
      controller.abort();
      clearInterval(fallback);
    };
  }, [refresh]);

  const togglePause = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      await setOutputsPaused(!snapshot.outputsPaused);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const quickstart = async () => {
    setBusy(true);
    try {
      const draft = await provisionCodexVirtual();
      Modal.confirm({
        title: t("previewTitle"),
        content: <Space direction="vertical"><Typography.Text>{t("previewBody")}</Typography.Text><code>{JSON.stringify(draft.impact)}</code></Space>,
        okText: t("publish"),
        onOk: async () => {
          await publishConfig(draft.revision);
          await refresh();
          messageApi.success(t("configured"));
        },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#5b5bd6", borderRadius: 10 } }}>
      <Layout className="app-shell">
        {contextHolder}
        <Header className="app-header">
          <Space size="middle">
            <div className="brand-mark"><ApiOutlined /></div>
            <div>
              <Typography.Title level={3}>{t("appName")}</Typography.Title>
              <Typography.Text type="secondary">{t("dashboard")}</Typography.Text>
            </div>
          </Space>
          <Space>
            <Tag color={snapshot ? "success" : "error"}>{snapshot ? t("connected") : t("disconnected")}</Tag>
            <Button
              danger={!snapshot?.outputsPaused}
              icon={snapshot?.outputsPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              loading={busy}
              disabled={!snapshot}
              onClick={() => void togglePause()}
            >
              {snapshot?.outputsPaused ? t("resumeOutputs") : t("pauseOutputs")}
            </Button>
          </Space>
        </Header>
        <Content className="content">
          {error && <Alert type="warning" showIcon message={t("reconnecting")} description={error} />}
          {snapshot?.outputsPaused && <Alert type="warning" showIcon message={t("paused")} />}
          {!snapshot?.claims.length && !snapshot?.projections.length && (
            <Alert
              type="info"
              showIcon
              message={t("firstRunTitle")}
              description={t("firstRunBody")}
              action={<Button type="primary" loading={busy} onClick={() => void quickstart()}>{t("configureCodex")}</Button>}
            />
          )}
          <Flex gap="middle" wrap="wrap" className="stats">
            <Card><Statistic title={t("revision")} value={snapshot?.revision ?? 0} /></Card>
            <Card><Statistic title={t("claims")} value={snapshot?.claims.length ?? 0} prefix={<BellOutlined />} /></Card>
            <Card><Statistic title={t("deliveries")} value={snapshot?.pendingDeliveries ?? 0} /></Card>
            <Card><Statistic title={t("deadLetters")} value={snapshot?.deadLetters ?? 0} valueStyle={{ color: snapshot?.deadLetters ? "#cf1322" : undefined }} /></Card>
          </Flex>
          <Card title={t("projections")} className="data-card">
            <Table
              rowKey="resourceKey"
              dataSource={snapshot?.projections ?? []}
              pagination={false}
              locale={{ emptyText: <Empty description={t("noProjections")} /> }}
              columns={[
                { title: t("resource"), dataIndex: "resourceKey" },
                { title: t("urgency"), dataIndex: "urgency", render: (value) => value ? <Tag>{String(value)}</Tag> : t("idle") },
                { title: t("action"), dataIndex: "action", render: (value) => value ? <code>{JSON.stringify(value)}</code> : t("idle") },
              ]}
            />
          </Card>
          <Card title={t("claims")} className="data-card">
            <Table
              rowKey={(row) => `${row.producerId}/${row.scopeId}/${row.signalId}`}
              dataSource={snapshot?.claims ?? []}
              pagination={{ pageSize: 20 }}
              locale={{ emptyText: <Empty description={t("noClaims")} /> }}
              columns={[
                { title: t("producer"), dataIndex: "producerId" },
                { title: t("scope"), dataIndex: "scopeId" },
                { title: t("signal"), dataIndex: "signalId" },
                { title: t("urgency"), dataIndex: "urgency", render: (value) => <Tag>{String(value ?? "ambient")}</Tag> },
                { title: t("updatedAt"), dataIndex: "updatedAt", render: (value) => new Date(String(value)).toLocaleString() },
              ]}
            />
          </Card>
        </Content>
        <Footer className="footer"><SafetyCertificateOutlined /> {t("privacy")}</Footer>
      </Layout>
    </ConfigProvider>
  );
}

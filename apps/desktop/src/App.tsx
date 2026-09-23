import {
  ApiOutlined,
  BellOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, ConfigProvider, Empty, Flex, Layout, Modal, Space, Statistic, Table, Tag, Typography, message, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { fetchSnapshot, getConnection, provisionCodexVirtual, publishConfig, setOutputsPaused, subscribe, type RuntimeSnapshot } from "./api.js";
import { CoreConnectionLoop } from "./connection-loop.js";
import { SourceManager } from "./SourceManager.js";
import { RuntimeManager } from "./RuntimeManager.js";
const ConfigManager = lazy(async () => await import("./ConfigManager.js").then((module) =>
  ({ default: module.ConfigManager })));
import "./app.css";

const { Header, Content, Footer } = Layout;

export default function App() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>();
  const [error, setError] = useState<string>();
  const [pauseError, setPauseError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showConfigManager, setShowConfigManager] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const connectionLoop = useRef<CoreConnectionLoop<RuntimeSnapshot> | null>(null);

  const refresh = useCallback(() => connectionLoop.current?.requestRefresh(), []);

  useEffect(() => {
    const loop = new CoreConnectionLoop<RuntimeSnapshot>(
      { connection: getConnection, snapshot: fetchSnapshot, subscribe },
      { snapshot: setSnapshot, error: setError },
    );
    connectionLoop.current = loop;
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const register = (event: string) => {
      void listen(event, () => loop.reconnectNow()).then((unlisten) => {
        if (disposed) unlisten();
        else listeners.push(unlisten);
      }).catch(() => undefined);
    };
    register("core-ready");
    register("core-terminated");
    loop.start();
    return () => {
      disposed = true;
      listeners.forEach((unlisten) => unlisten());
      if (connectionLoop.current === loop) connectionLoop.current = null;
      void loop.stop();
    };
  }, []);

  const togglePause = async () => {
    if (!snapshot) return;
    setBusy(true);
    setPauseError(false);
    try {
      await setOutputsPaused(!snapshot.outputsPaused);
      refresh();
    } catch {
      setPauseError(true);
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
          refresh();
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
          {pauseError && <Alert type="error" showIcon message={t("pauseFailed")} />}
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
          <SourceManager disabled={!snapshot} onPublished={refresh} />
          <Button disabled={!snapshot} onClick={() => setShowConfigManager((value) => !value)}>
            {t("manageConfig")}
          </Button>
          {showConfigManager && <Suspense fallback={<Card>{t("loadingConfig")}</Card>}>
            <ConfigManager disabled={!snapshot} onPublished={refresh} />
          </Suspense>}
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
          <RuntimeManager claims={snapshot?.claims ?? []} disabled={!snapshot} onChanged={refresh} />
        </Content>
        <Footer className="footer"><SafetyCertificateOutlined /> {t("privacy")}</Footer>
      </Layout>
    </ConfigProvider>
  );
}

import { ApiOutlined, AppstoreOutlined, BugOutlined, ControlOutlined, LinkOutlined, PauseCircleOutlined,
  PlayCircleOutlined, SettingOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Alert, Button, ConfigProvider, Empty, Modal, Space, Table, Tabs, Tag, message, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { fetchSnapshot, getConnection, setOutputsPaused, subscribe, type RuntimeSnapshot } from "./api.js";
import { CoreConnectionLoop } from "./connection-loop.js";
import { SourceManager } from "./SourceManager.js";
import { RuntimeManager } from "./RuntimeManager.js";
import { Diagnostics } from "./Diagnostics.js";
import { CredentialManager } from "./CredentialManager.js";
import type { ConfigSection } from "./ConfigManager.js";
const ConfigManager = lazy(async () => await import("./ConfigManager.js").then((module) => ({ default: module.ConfigManager })));
import "./app.css";

type Page = "overview" | "sources" | "outputs" | "rules" | "diagnostics" | "settings";
const pages = [
  { key: "overview", title: "概览", icon: <AppstoreOutlined />, description: "查看当前状态、期望输出与需要关注的异常。" },
  { key: "sources", title: "来源", icon: <LinkOutlined />, description: "管理哪些程序可以向 State Hub 报告信息。" },
  { key: "outputs", title: "输出", icon: <ApiOutlined />, description: "配置设备与通知服务；可以先添加输出，稍后再关联规则。" },
  { key: "rules", title: "规则", icon: <ShareAltOutlined />, description: "规定什么情况下，通过哪个输出，以什么方式提醒你。" },
  { key: "diagnostics", title: "诊断", icon: <BugOutlined />, description: "检查最近投递与安全错误摘要，或导出支持包。" },
  { key: "settings", title: "设置", icon: <SettingOutlined />, description: "管理凭据、配置版本和应用信息。" },
] as const;

export default function App() {
  const [modal, modalContext] = Modal.useModal();
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>("overview");
  const [settingsTab, setSettingsTab] = useState("credentials");
  const [configVisited, setConfigVisited] = useState(false);
  const [configSection, setConfigSection] = useState<ConfigSection>("outputs");
  const [dirty, setDirty] = useState({ output: false, rule: false });
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>();
  const [error, setError] = useState<string>();
  const [pauseError, setPauseError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updaterAvailable, setUpdaterAvailable] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const connectionLoop = useRef<CoreConnectionLoop<RuntimeSnapshot> | null>(null);
  const content = useRef<HTMLElement>(null);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [page, settingsTab]);
  const refresh = useCallback(() => connectionLoop.current?.requestRefresh(), []);
  const dirtyChanged = useCallback((output: boolean, rule: boolean) => setDirty({ output, rule }), []);
  const navigate = (next: Page) => {
    setPage(next);
    if (next === "outputs" || next === "rules") { setConfigVisited(true); setConfigSection(next); }
    if (next === "settings" && settingsTab === "versions") { setConfigVisited(true); setConfigSection("versions"); }
  };
  const configVisible = page === "outputs" || page === "rules" || (page === "settings" && settingsTab === "versions");

  useEffect(() => {
    const firstFrame = requestAnimationFrame(() => {
      requestAnimationFrame(() => { void invoke("record_first_paint").catch(() => undefined); });
    });
    void invoke<boolean>("updater_available").then(setUpdaterAvailable).catch(() => undefined);
    return () => cancelAnimationFrame(firstFrame);
  }, []);
  useEffect(() => {
    const loop = new CoreConnectionLoop<RuntimeSnapshot>(
      { connection: getConnection, snapshot: fetchSnapshot, subscribe }, { snapshot: setSnapshot, error: setError });
    connectionLoop.current = loop;
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const register = (event: string) => {
      void listen(event, () => loop.reconnectNow()).then((unlisten) => {
        if (disposed) unlisten(); else listeners.push(unlisten);
      }).catch(() => undefined);
    };
    register("core-ready"); register("core-terminated"); loop.start();
    return () => { disposed = true; listeners.forEach((unlisten) => unlisten());
      if (connectionLoop.current === loop) connectionLoop.current = null;
      void loop.stop(); };
  }, []);
  const togglePause = async () => {
    if (!snapshot) return;
    setBusy(true); setPauseError(false);
    try { await setOutputsPaused(!snapshot.outputsPaused); refresh(); }
    catch { setPauseError(true); }
    finally { setBusy(false); }
  };
  const checkForUpdate = async () => {
    setUpdateBusy(true);
    try {
      const update = await invoke<{ version: string } | null>("check_update");
      if (!update) { messageApi.info(t("noUpdate")); return; }
      modal.confirm({ title: t("updateAvailable", { version: update.version }), content: t("updateInstallNotice"),
        okText: t("installUpdate"), cancelText: t("cancel"), onOk: async () => {
          try { await invoke("install_update", { expectedVersion: update.version }); messageApi.success(t("updateInstalled")); }
          catch { messageApi.error(t("updateFailed")); }
        } });
    } catch { messageApi.error(t("updateCheckFailed")); }
    finally { setUpdateBusy(false); }
  };
  const current = pages.find((item) => item.key === page)!;
  return <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm,
    token: { colorPrimary: "#5b5bd6", borderRadius: 6, fontSize: 13, controlHeight: 32 } }}>
    {contextHolder}
    {modalContext}
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><ControlOutlined /></span><span>State Hub<small>本地信号与输出</small></span></div>
        <nav aria-label="主导航">{pages.map((item) => <button key={item.key} type="button" className={`nav-item ${page === item.key ? "selected" : ""}`}
          aria-label={item.title} aria-current={page === item.key ? "page" : undefined} onClick={() => navigate(item.key)}>
          {item.icon}<span>{item.title}</span>{((item.key === "outputs" && dirty.output) || (item.key === "rules" && dirty.rule)) &&
            <span className="dirty-dot" title="有未保存编辑" aria-label="有未保存编辑" />}
        </button>)}</nav>
        <div className="sidebar-status"><span className={`status-dot ${snapshot ? "online" : ""}`} />
          {snapshot ? "本地服务已连接" : error ? "正在重新连接" : "正在连接"}
          <small>配置与状态保存在本机</small></div>
      </aside>
      <div className="main-shell">
        <header className="page-header"><div><h1>{current.title}</h1><p>{current.description}</p></div>
          <Button aria-label={snapshot?.outputsPaused ? t("resumeOutputs") : t("pauseOutputs")}
            icon={snapshot?.outputsPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
            loading={busy} disabled={!snapshot} onClick={() => void togglePause()}>
            {snapshot?.outputsPaused ? t("resumeOutputs") : t("pauseOutputs")}</Button></header>
        <div className="global-notices" aria-live="polite">
          {error && <Alert type="warning" showIcon message="正在重新连接本地服务；未保存的编辑会保留。" />}
          {pauseError && <Alert type="error" showIcon message={t("pauseFailed")} />}
          {snapshot?.outputsPaused && <Alert type="warning" showIcon message="输出已暂停，输入仍在更新。恢复时重算当前状态，不补发暂停期间被抑制的事件。" />}
        </div>
        <main ref={content} className="content" id="main-content">
          <section hidden={page !== "overview"} aria-label="运行概览">
            <div className="overview-stats">
              <div><span>当前状态</span><strong>{snapshot?.claims.length ?? "—"}</strong></div>
              <div><span>当前输出通道</span><strong>{snapshot?.projections.length ?? "—"}</strong></div>
              <button onClick={() => navigate("diagnostics")}><span>待投递</span><strong>{snapshot?.pendingDeliveries ?? "—"}</strong></button>
              <button onClick={() => navigate("diagnostics")} className={snapshot?.deadLetters ? "has-errors" : ""}><span>失败归档</span><strong>{snapshot?.deadLetters ?? "—"}</strong></button>
            </div>
            {!snapshot ? <Empty description={error ? "连接恢复后显示最新运行状态" : "正在读取运行状态…"} /> : <>
              {snapshot.claims.length === 0 && snapshot.projections.length === 0 && <Alert type="info" showIcon
                message="当前没有运行数据" description="已配置的来源也可能暂时没有上报。可检查来源接入，或通过虚拟输出了解联动过程。"
                action={<Button onClick={() => navigate("sources")}>查看来源</Button>} />}
              <Tabs items={[
                { key: "states", label: "当前状态", children: <RuntimeManager view="claims" claims={snapshot.claims} disabled={false} onChanged={refresh} /> },
                { key: "outputs", label: "当前输出", children: <>
                  <p className="muted">系统决定各通道当前应呈现的状态；不代表设备已经执行成功，也不包含全部通知历史。</p>
                  <Table size="small" rowKey="resourceKey" dataSource={snapshot.projections} pagination={{ pageSize: 15 }}
                    expandable={{ expandedRowRender: (row) => <pre>{JSON.stringify(row, null, 2)}</pre> }}
                    columns={[
                      { title: "输出", dataIndex: "driverInstanceId" },
                      { title: "通道", dataIndex: "resourceChannel" },
                      { title: "紧急度", dataIndex: "urgency", render: (value) => value ? <Tag>{String(value)}</Tag> : "空闲" },
                      { title: "期望动作", dataIndex: "action", render: (value) => value ? String(value.name) : "空闲" },
                    ]} />
                </> },
              ]} />
              <details className="runtime-detail"><summary>运行详情</summary><p>内部运行修订号：{snapshot.revision}（不是软件版本或配置版本）</p></details>
            </>}
          </section>
          <section hidden={page !== "sources"} aria-label="来源接入"><SourceManager disabled={!snapshot} active={page === "sources"} onPublished={refresh} onContinue={() => navigate("outputs")} /></section>
          <section hidden={page !== "diagnostics"} aria-label="运行诊断"><Diagnostics disabled={!snapshot}
            {...(snapshot ? { pending: snapshot.pendingDeliveries, failed: snapshot.deadLetters } : {})} /></section>
          <section hidden={page !== "settings"} aria-label="应用设置">
            <Tabs activeKey={settingsTab} onChange={(key) => { setSettingsTab(key); if (key === "versions") { setConfigVisited(true); setConfigSection("versions"); } }}
              items={[{ key: "credentials", label: "凭据" }, { key: "versions", label: "配置版本" }, { key: "about", label: "关于" }]} />
            {page === "settings" && settingsTab === "credentials" && <CredentialManager disabled={!snapshot} />}
            {settingsTab === "about" && <div className="about-panel"><h2>State Hub</h2><p>本地信号路由与输出协调。关闭窗口会隐藏到托盘，后台继续运行。</p>
              <p>{t("privacy")}</p><p>未保存编辑在真正退出后不恢复；配置版本回滚不恢复来源授权或密钥。</p>
              {updaterAvailable ? <Button loading={updateBusy} onClick={() => void checkForUpdate()}>{t("checkForUpdate")}</Button> : <p className="muted">当前构建未启用在线更新。</p>}
            </div>}
          </section>
          <section hidden={!configVisible} aria-label="配置工作区">
            {configVisited && <Suspense fallback={<p>正在加载配置工作区…</p>}><ConfigManager disabled={!snapshot} active={configVisible}
              section={configSection} onPublished={refresh} onDirtyChange={dirtyChanged}
              onNavigate={(next) => { if (next === "versions") { setSettingsTab("versions"); setConfigSection(next); setPage("settings"); }
                else navigate(next); }} /></Suspense>}
          </section>
        </main>
      </div>
    </div>
  </ConfigProvider>;
}

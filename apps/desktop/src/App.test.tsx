// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchSnapshot, getConnection, setOutputsPaused, subscribe } from "./api.js";
import { listProducers, listSources } from "./management.js";
import { loadConfigCatalog, loadConfigRevisions, loadManagedConfig } from "./config-management.js";
import App from "./App.js";
import { setupDom, renderUi as render } from "./test-support/dom.js";
import "./i18n.js";
import { ConnectionFailure, connectionNotices } from "./connection-errors.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./api.js", async (original) => ({ ...await original<typeof import("./api.js")>(),
  fetchSnapshot: vi.fn(), getConnection: vi.fn(), subscribe: vi.fn(), setOutputsPaused: vi.fn() }));
vi.mock("./management.js", async (original) => ({ ...await original<typeof import("./management.js")>(), listProducers: vi.fn(), listSources: vi.fn() }));
vi.mock("./config-management.js", async (original) => ({ ...await original<typeof import("./config-management.js")>(),
  loadConfigCatalog: vi.fn(), loadConfigRevisions: vi.fn(), loadManagedConfig: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks(); setupDom();
  vi.mocked(invoke).mockResolvedValue(false); vi.mocked(listen).mockResolvedValue(() => undefined);
  vi.mocked(getConnection).mockResolvedValue({ endpoint: "http://localhost:1", adminToken: "test", generation: 1 });
  vi.mocked(fetchSnapshot).mockResolvedValue({ revision: 2, outputsPaused: false, claims: [], projections: [], pendingDeliveries: 0, deadLetters: 0 });
  vi.mocked(subscribe).mockImplementation(async (_connection, _onChange, signal) => await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  }));
  vi.mocked(setOutputsPaused).mockResolvedValue();
  vi.mocked(listSources).mockResolvedValue([]); vi.mocked(listProducers).mockResolvedValue([]);
  vi.mocked(loadManagedConfig).mockResolvedValue({ driverInstances: [], bindings: [] });
  vi.mocked(loadConfigRevisions).mockResolvedValue([]);
  vi.mocked(loadConfigCatalog).mockResolvedValue({ sourceDefinitions: [], driverDefinitions: [{
    id: "official.virtual", version: "1", displayNameKey: "virtual", configSchema: { type: "object", additionalProperties: false },
    actions: { render: { kind: "stateful", paramsSchema: { type: "object" } } },
  }] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const nav = (name: string) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });

it("starts in overview, reaches all six modules, and keeps a single subscription", async () => {
  render(<App />);
  await screen.findByText("本地服务已连接"); expect(nav("概览").getAttribute("aria-current")).toBe("page");
  expect(listSources).not.toHaveBeenCalled();
  for (const name of ["来源", "输出", "规则", "诊断", "设置", "概览"]) {
    fireEvent.click(nav(name)); await screen.findByRole("heading", { name, level: 1 });
  }
  expect(subscribe).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "暂停所有输出" }));
  await waitFor(() => expect(setOutputsPaused).toHaveBeenCalledWith(true));
  expect(subscribe).toHaveBeenCalledOnce();
}, 15_000);

it("retains unfinished output form across navigation and clears credential input on leaving settings", async () => {
  render(<App />); await screen.findByText("本地服务已连接");
  fireEvent.click(nav("输出"));
  await waitFor(() => expect((screen.getByRole("button", { name: "新增输出" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5_000 });
  fireEvent.click(screen.getByRole("button", { name: "新增输出" }));
  const id = document.getElementById("output_id") as HTMLInputElement;
  fireEvent.change(id, { target: { value: "unsaved-output" } });
  fireEvent.click(nav("设置"));
  fireEvent.change(screen.getByLabelText("密钥"), { target: { value: "temporary-private-value" } });
  fireEvent.click(nav("来源")); fireEvent.click(nav("输出"));
  await waitFor(() => expect((document.getElementById("output_id") as HTMLInputElement).value).toBe("unsaved-output"));
  expect(within(nav("输出")).getByLabelText("有未保存编辑")).toBeTruthy();
  fireEvent.click(nav("设置")); expect((screen.getByLabelText("密钥") as HTMLInputElement).value).toBe("");
  expect(subscribe).toHaveBeenCalledOnce();
}, 15_000);

it("shows persistent startup exhaustion instead of promising reconnection", async () => {
  vi.mocked(getConnection).mockRejectedValue(new ConnectionFailure("CORE_RESTART_EXHAUSTED"));
  render(<App />);
  await screen.findByText(connectionNotices.CORE_RESTART_EXHAUSTED.message);
  expect(screen.queryByText("正在重新连接")).toBeNull();
  expect(fetchSnapshot).not.toHaveBeenCalled();
});

it("keeps unsaved output editing through a network failure and clears the safe notice on recovery", async () => {
  let disconnect: (() => void) | undefined;
  vi.mocked(subscribe).mockImplementationOnce(async (_connection, _notice, signal) => await new Promise<void>((resolve, reject) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    disconnect = () => reject(new TypeError("private-network-detail"));
  }));
  render(<App />); await screen.findByText("本地服务已连接");
  fireEvent.click(nav("输出"));
  await waitFor(() => expect((screen.getByRole("button", { name: "新增输出" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5_000 });
  fireEvent.click(screen.getByRole("button", { name: "新增输出" }));
  fireEvent.change(document.getElementById("output_id")!, { target: { value: "keep-after-disconnect" } });
  disconnect!();
  await screen.findByText(connectionNotices.UNAVAILABLE.message);
  expect(document.body.textContent).not.toContain("private-network-detail");
  await screen.findByText("本地服务已连接");
  expect(screen.queryByText(connectionNotices.UNAVAILABLE.message)).toBeNull();
  expect((document.getElementById("output_id") as HTMLInputElement).value).toBe("keep-after-disconnect");
}, 15_000);

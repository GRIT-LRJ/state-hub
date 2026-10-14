// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Modal } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "@state-hub/protocol";
import type { ConfigCatalog, ConfigInstance, ManagedConfig } from "./config-management.js";
import { loadConfigCatalog, loadConfigRevisions, loadManagedConfig, previewManagedConfig, previewRollback, publishManagedConfig } from "./config-management.js";
import { listProducers, secretExists } from "./management.js";
import { ConfigManager } from "./ConfigManager.js";
import { setupDom, renderUi as render } from "./test-support/dom.js";

vi.mock("./config-management.js", async (original) => ({ ...await original<typeof import("./config-management.js")>(),
  loadConfigCatalog: vi.fn(), loadConfigRevisions: vi.fn(), loadManagedConfig: vi.fn(),
  previewManagedConfig: vi.fn(), previewRollback: vi.fn(), publishManagedConfig: vi.fn(),
}));
vi.mock("./management.js", async (original) => ({ ...await original<typeof import("./management.js")>(), listProducers: vi.fn(), secretExists: vi.fn() }));

const output: ConfigInstance = { id: "virtual-main", driverType: "virtual", enabled: true, config: {} };
const binding: Binding = { id: "structured", name: "原规则", enabled: true, selector: { producerId: "source", signalId: "status" },
  conditions: [{ pointer: "/severity", operator: "eq", value: "urgent" }],
  mapping: { fixed: { kind: "constant", value: "green" }, selected: { kind: "pointer", pointer: "/content" }, formatted: { kind: "template", template: "{{content}}" } },
  target: { driverInstanceId: output.id, resourceChannel: "light", actionKind: "stateful", actionName: "render" } };
const catalog: ConfigCatalog = { driverDefinitions: [
  { id: "official.virtual", version: "1.0.0", displayNameKey: "virtual", configSchema: { type: "object", additionalProperties: false },
    actions: { render: { kind: "stateful", paramsSchema: { type: "object" } } } },
  { id: "official.pushplus", version: "1.0.0", displayNameKey: "pushplus", configSchema: { type: "object", required: ["tokenSecretRef"],
    properties: { tokenSecretRef: { type: "string", format: "statehub-secret-ref" } } },
    actions: { send: { kind: "append-only", paramsSchema: { type: "object" } } } },
], sourceDefinitions: [] };
let current: ManagedConfig;
let candidate: ManagedConfig;
beforeEach(() => {
  vi.resetAllMocks(); setupDom();
  current = { driverInstances: [], bindings: [] }; candidate = current;
  vi.mocked(loadConfigCatalog).mockResolvedValue(catalog);
  vi.mocked(loadManagedConfig).mockImplementation(async () => structuredClone(current));
  vi.mocked(loadConfigRevisions).mockResolvedValue([{ revision: 1, status: "published", impact: {}, createdAt: "2026-01-01", publishedAt: "2026-01-01" }]);
  vi.mocked(previewManagedConfig).mockImplementation(async (config) => { candidate = structuredClone(config); return { revision: 2, impact: { historicalEventsReplayed: 0 } }; });
  vi.mocked(previewRollback).mockResolvedValue({ revision: 3, impact: { historicalEventsReplayed: 0 }, rolledBackFrom: 1 });
  vi.mocked(publishManagedConfig).mockImplementation(async () => { current = structuredClone(candidate); });
  vi.mocked(listProducers).mockResolvedValue([]); vi.mocked(secretExists).mockResolvedValue(true);
});
afterEach(() => { act(() => Modal.destroyAll()); cleanup(); vi.unstubAllGlobals(); });
const noop = () => undefined;
const button = (name: string) => screen.getByRole("button", { name });
const field = (id: string) => { const input = document.getElementById(id) as HTMLInputElement; expect(input).toBeTruthy(); return input; };
async function ready(name: string) { await waitFor(() => expect((button(name) as HTMLButtonElement).disabled).toBe(false)); }
async function reviewOutput(id = "new-output") {
  await ready("新增输出"); fireEvent.click(button("新增输出"));
  fireEvent.change(field("output_id"), { target: { value: id } });
  fireEvent.click(button("审阅本次输出修改"));
  await screen.findByRole("dialog", { name: "审阅本次修改" });
}

describe("independent desktop configuration operations", () => {
  it("validates and applies an output without requiring a rule", async () => {
    render(<ConfigManager disabled={false} onPublished={noop} />);
    await ready("新增输出"); fireEvent.click(button("新增输出"));
    fireEvent.submit(field("output_id").closest("form")!);
    await screen.findByText("INVALID_DRIVER_FORM"); expect(previewManagedConfig).not.toHaveBeenCalled();
    fireEvent.change(field("output_id"), { target: { value: "keyboard-test" } });
    fireEvent.click(button("审阅本次输出修改"));
    await screen.findByRole("dialog", { name: "审阅本次修改" });
    expect(candidate).toEqual({ driverInstances: [{ id: "keyboard-test", driverType: "official.virtual", enabled: true, config: {} }], bindings: [] });
    expect(publishManagedConfig).not.toHaveBeenCalled();
    fireEvent.click(button("应用本次修改"));
    await screen.findByText("未关联规则");
    expect(current.bindings).toEqual([]); expect(publishManagedConfig).toHaveBeenCalledWith(2);
  });

  it("keeps output edits while applying only a rule, then preserves the published rule when applying output", async () => {
    current = { driverInstances: [output], bindings: [binding] };
    const view = render(<ConfigManager section="outputs" disabled={false} onPublished={noop} />);
    await ready("编辑输出"); fireEvent.click(button("编辑输出"));
    fireEvent.change(field("output_physicalResourceKey"), { target: { value: "edited-device" } });
    view.rerender(<ConfigManager section="rules" disabled={false} onPublished={noop} />);
    await ready("编辑规则"); fireEvent.click(button("编辑规则"));
    fireEvent.change(field("rule_name"), { target: { value: "独立应用规则" } });
    fireEvent.click(button("审阅本次规则修改"));
    await screen.findByRole("dialog", { name: "审阅本次修改" });
    expect(candidate.driverInstances).toEqual([output]); expect(candidate.bindings[0]?.name).toBe("独立应用规则");
    fireEvent.click(button("应用本次修改")); await waitFor(() => expect(current.bindings[0]?.name).toBe("独立应用规则"));
    await ready("编辑规则");
    view.rerender(<ConfigManager section="outputs" disabled={false} onPublished={noop} />);
    await ready("审阅本次输出修改"); expect(field("output_physicalResourceKey").value).toBe("edited-device");
    fireEvent.click(button("审阅本次输出修改")); await screen.findByRole("dialog", { name: "审阅本次修改" });
    expect(candidate.bindings[0]?.name).toBe("独立应用规则");
    expect(candidate.driverInstances[0]?.physicalResourceKey).toBe("edited-device");
  });

  it("preserves form contents across disconnect and discards a late preview", async () => {
    let resolvePreview!: (value: { revision: number; impact: Record<string, unknown> }) => void;
    vi.mocked(previewManagedConfig).mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    const view = render(<ConfigManager disabled={false} onPublished={noop} />);
    await ready("新增输出"); fireEvent.click(button("新增输出")); fireEvent.change(field("output_id"), { target: { value: "retained" } });
    fireEvent.click(button("审阅本次输出修改")); await waitFor(() => expect(previewManagedConfig).toHaveBeenCalledOnce());
    view.rerender(<ConfigManager disabled onPublished={noop} />);
    await act(async () => resolvePreview({ revision: 2, impact: {} }));
    expect(screen.queryByRole("dialog", { name: "审阅本次修改" })).toBeNull();
    view.rerender(<ConfigManager disabled={false} onPublished={noop} />);
    await ready("审阅本次输出修改"); expect(field("output_id").value).toBe("retained");
    expect(publishManagedConfig).not.toHaveBeenCalled();
  });

  it("does not publish if disconnected during the final baseline read", async () => {
    const view = render(<ConfigManager disabled={false} onPublished={noop} />);
    await reviewOutput();
    let resolveRead!: (value: ManagedConfig) => void;
    vi.mocked(loadManagedConfig).mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    fireEvent.click(button("应用本次修改"));
    view.rerender(<ConfigManager disabled onPublished={noop} />);
    await act(async () => resolveRead(current));
    expect(publishManagedConfig).not.toHaveBeenCalled(); expect(field("output_id").value).toBe("new-output");
  });

  it("rejects obsolete previews and retains input for a new review", async () => {
    render(<ConfigManager disabled={false} onPublished={noop} />); await reviewOutput();
    current = { driverInstances: [output], bindings: [] };
    fireEvent.click(button("应用本次修改")); await screen.findByText("CONFIG_CHANGED_RELOAD");
    expect(publishManagedConfig).not.toHaveBeenCalled(); expect(field("output_id").value).toBe("new-output");
    fireEvent.click(button("审阅本次输出修改")); await screen.findByRole("dialog", { name: "审阅本次修改" });
    expect(candidate.driverInstances.map((item) => item.id)).toEqual(["virtual-main", "new-output"]);
  });

  it("shows referenced rules before refusing to delete an output", async () => {
    current = { driverInstances: [output], bindings: [binding] };
    render(<ConfigManager disabled={false} onPublished={noop} />); await ready("移除输出"); fireEvent.click(button("移除输出"));
    const dialog = await screen.findByRole("dialog"); expect(within(dialog).getByText("原规则")).toBeTruthy();
    expect(previewManagedConfig).not.toHaveBeenCalled();
  });

  it("retains structured mappings and reindexes condition text correctly after removing a row", async () => {
    current = { driverInstances: [output], bindings: [{ ...binding, conditions: [
      { pointer: "/first", operator: "eq", value: "A" }, { pointer: "/second", operator: "eq", value: "B" },
    ] }] };
    render(<ConfigManager section="rules" disabled={false} onPublished={noop} />);
    await ready("编辑规则"); fireEvent.click(button("编辑规则"));
    fireEvent.click(button("移除条件 1"));
    expect((screen.getByLabelText("比较值 1") as HTMLTextAreaElement).value).toBe('"B"');
    fireEvent.change(screen.getByLabelText("比较值 1"), { target: { value: "invalid" } });
    expect((button("审阅本次规则修改") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("比较值 1"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("常量 fixed"), { target: { value: "invalid json" } });
    fireEvent.click(button("审阅本次规则修改")); await screen.findByText("INVALID_BINDING_FORM");
    expect(previewManagedConfig).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("常量 fixed"), { target: { value: "42" } });
    fireEvent.click(button("审阅本次规则修改")); await screen.findByRole("dialog", { name: "审阅本次修改" });
    expect(candidate.bindings[0]).toMatchObject({ conditions: [{ pointer: "/second", operator: "eq", value: 7 }],
      mapping: { fixed: { kind: "constant", value: 42 }, selected: { kind: "pointer", pointer: "/content" }, formatted: { kind: "template", template: "{{content}}" } } });
  });

  it("offers recovery when the selected output changes without discarding rule contents", async () => {
    current = { driverInstances: [output], bindings: [binding] };
    render(<ConfigManager section="rules" disabled={false} onPublished={noop} />);
    await ready("编辑规则"); fireEvent.click(button("编辑规则"));
    fireEvent.change(field("rule_name"), { target: { value: "保留此名称" } });
    current = { ...current, driverInstances: [{ ...output, physicalResourceKey: "changed" }] };
    fireEvent.click(button("审阅本次规则修改")); await screen.findByText("OUTPUT_CHANGED");
    fireEvent.click(button("更新目标输出信息并保留规则编辑")); await ready("审阅本次规则修改");
    fireEvent.click(button("审阅本次规则修改")); await screen.findByRole("dialog", { name: "审阅本次修改" });
    expect(candidate.bindings[0]?.name).toBe("保留此名称");
  });

  it("uses safe text for plugin descriptions", async () => {
    vi.mocked(loadConfigCatalog).mockResolvedValue({ ...catalog, driverDefinitions: [{ ...catalog.driverDefinitions[0]!,
      configSchema: { type: "object", properties: { label: { type: "string", description: '<img src=x onerror="window.injected=true">' } } } }] });
    const { container } = render(<ConfigManager disabled={false} onPublished={noop} />);
    await ready("新增输出"); fireEvent.click(button("新增输出"));
    expect(container.querySelector('img[src="x"]')).toBeNull(); expect(container.textContent).toContain('<img src=x');
  });

  it("keeps PushPlus output creation separate from its optional rule and requires a credential", async () => {
    const navigate = vi.fn(); render(<ConfigManager disabled={false} onPublished={noop} onNavigate={navigate} />);
    await ready("PushPlus 引导"); fireEvent.click(button("PushPlus 引导"));
    vi.mocked(secretExists).mockResolvedValueOnce(false);
    fireEvent.click(button("审阅本次输出修改")); await screen.findByText("CREDENTIAL_MISSING");
    expect(previewManagedConfig).not.toHaveBeenCalled();
    fireEvent.click(button("审阅本次输出修改")); await screen.findByRole("dialog", { name: "审阅本次修改" });
    fireEvent.click(button("应用本次修改")); await screen.findByText("未关联规则");
    expect(current.bindings).toEqual([]);
    fireEvent.click(button("继续添加规则")); await waitFor(() => expect(navigate).toHaveBeenCalledWith("rules"));
    expect(current.bindings).toEqual([]); expect(publishManagedConfig).toHaveBeenCalledOnce();
  });

  it("previews a whole-config rollback and blocks it while an editor is open", async () => {
    const view = render(<ConfigManager disabled={false} onPublished={noop} />);
    await ready("新增输出"); fireEvent.click(button("新增输出"));
    view.rerender(<ConfigManager section="versions" disabled={false} onPublished={noop} />);
    expect((button("回滚并预览") as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ConfigManager section="outputs" disabled={false} onPublished={noop} />);
    fireEvent.click(button("放弃本次编辑"));
    view.rerender(<ConfigManager section="versions" disabled={false} onPublished={noop} />);
    await ready("回滚并预览"); fireEvent.click(button("回滚并预览"));
    await screen.findByText("恢复整套配置到版本 #1"); fireEvent.click(button("应用本次修改"));
    await waitFor(() => expect(publishManagedConfig).toHaveBeenCalledWith(3));
  });
});

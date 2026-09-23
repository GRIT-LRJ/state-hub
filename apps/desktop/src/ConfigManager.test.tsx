// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigCatalog, ManagedConfig } from "./config-management.js";
import {
  loadConfigCatalog, loadConfigRevisions, loadManagedConfig, previewManagedConfig,
  previewRollback, publishManagedConfig,
} from "./config-management.js";
import { ConfigManager } from "./ConfigManager.js";

vi.mock("./config-management.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config-management.js")>(),
  loadConfigCatalog: vi.fn(), loadConfigRevisions: vi.fn(), loadManagedConfig: vi.fn(),
  previewManagedConfig: vi.fn(), previewRollback: vi.fn(), publishManagedConfig: vi.fn(),
}));

const catalog: ConfigCatalog = {
  driverDefinitions: [{
    id: "official.virtual", version: "1.0.0", displayNameKey: "virtual",
    configSchema: { type: "object", additionalProperties: false },
    actions: { render: { kind: "stateful", paramsSchema: { type: "object" } } },
  }],
  sourceDefinitions: [],
};
const empty: ManagedConfig = { driverInstances: [], bindings: [] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener: vi.fn(),
    removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(loadConfigCatalog).mockResolvedValue(catalog);
  vi.mocked(loadManagedConfig).mockResolvedValue(empty);
  vi.mocked(loadConfigRevisions).mockResolvedValue([{ revision: 1, status: "published",
    impact: {}, createdAt: "2026-01-01", publishedAt: "2026-01-01" }]);
  vi.mocked(previewManagedConfig).mockResolvedValue({ revision: 2, impact: {
    bindingsAdded: [], historicalEventsReplayed: 0,
  } });
  vi.mocked(previewRollback).mockResolvedValue({ revision: 3, impact: {
    historicalEventsReplayed: 0,
  }, rolledBackFrom: 1 });
  vi.mocked(publishManagedConfig).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("desktop configuration lifecycle", () => {
  it("creates a Virtual instance through a catalog schema and stages only after form validation", async () => {
    render(<ConfigManager disabled={false} onPublished={() => undefined} />);
    await screen.findByRole("button", { name: "新增驱动" });
    fireEvent.click(screen.getByRole("button", { name: "新增驱动" }));
    expect(screen.getByText("official.virtual")).toBeTruthy();
    const input = document.querySelector('input[id="root_id"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "virtual-main" } });
    fireEvent.click(screen.getByRole("button", { name: "保存驱动到草案" }));
    await screen.findByText(/virtual-main · official.virtual/);
    expect(previewManagedConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "完整校验并预览影响" }));
    await waitFor(() => expect(previewManagedConfig).toHaveBeenCalledWith({
      driverInstances: [{ id: "virtual-main", driverType: "official.virtual", enabled: true, config: {} }],
      bindings: [],
    }));
    await screen.findByText(/Core 校验通过/);
  });

  it("edits an existing Core Virtual instance that uses its legacy type alias", async () => {
    vi.mocked(loadManagedConfig).mockResolvedValue({
      driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      bindings: [],
    });
    render(<ConfigManager disabled={false} onPublished={() => undefined} />);
    await screen.findByText(/virtual-main · virtual/);
    fireEvent.click(screen.getByRole("button", { name: "编辑驱动" }));
    const physicalKey = document.querySelector('input[id="root_physicalResourceKey"]') as HTMLInputElement;
    fireEvent.change(physicalKey, { target: { value: "test-resource" } });
    fireEvent.click(screen.getByRole("button", { name: "保存驱动到草案" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存驱动到草案" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "完整校验并预览影响" }));
    await waitFor(() => expect(previewManagedConfig).toHaveBeenCalledWith({
      driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true,
        config: {}, physicalResourceKey: "test-resource" }],
      bindings: [],
    }));
  });

  it("renders conditions and constant, pointer, and template mappings as host fields", async () => {
    vi.mocked(loadManagedConfig).mockResolvedValue({
      driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
      bindings: [{
        id: "structured", name: "Structured mapping", enabled: true,
        selector: { producerId: "source", signalId: "status" },
        conditions: [{ pointer: "/severity", operator: "eq", value: "urgent" }],
        mapping: {
          fixed: { kind: "constant", value: "green" },
          selected: { kind: "pointer", pointer: "/content" },
          formatted: { kind: "template", template: "{{content}}" },
        },
        target: { driverInstanceId: "virtual-main", resourceChannel: "light",
          actionKind: "stateful", actionName: "render" },
      }],
    });
    render(<ConfigManager disabled={false} onPublished={() => undefined} />);
    await screen.findByText(/structured · Structured mapping/);
    fireEvent.click(screen.getByRole("button", { name: "编辑绑定" }));
    expect((screen.getByLabelText("条件指针 1") as HTMLInputElement).value).toBe("/severity");
    expect((screen.getByLabelText("比较值 1") as HTMLTextAreaElement).value).toBe('"urgent"');
    fireEvent.change(screen.getByLabelText("比较值 1"), { target: { value: "bad json" } });
    await waitFor(() => expect((screen.getByRole("button", {
      name: "保存绑定到草案",
    }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.change(screen.getByLabelText("比较值 1"), { target: { value: "7" } });
    expect((screen.getByLabelText("pointer selected") as HTMLInputElement).value).toBe("/content");
    expect((screen.getByLabelText("template formatted") as HTMLInputElement).value).toBe("{{content}}");
    expect((screen.getByLabelText("常量 fixed") as HTMLTextAreaElement).value).toBe('"green"');
    fireEvent.change(screen.getByLabelText("常量 fixed"), { target: { value: "invalid json" } });
    await screen.findByText("常量必须是有效 JSON");
    fireEvent.click(screen.getByRole("button", { name: "保存绑定到草案" }));
    await screen.findByText(/INVALID_BINDING_FORM/);
    expect(previewManagedConfig).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("常量 fixed"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "保存绑定到草案" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存绑定到草案" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "完整校验并预览影响" }));
    await waitFor(() => expect(previewManagedConfig).toHaveBeenCalledWith(expect.objectContaining({
      bindings: [expect.objectContaining({
        conditions: [{ pointer: "/severity", operator: "eq", value: 7 }],
        mapping: expect.objectContaining({ fixed: { kind: "constant", value: 42 } }),
      })],
    })));
  });

  it("treats catalog schema descriptions as text, not plugin HTML", async () => {
    vi.mocked(loadConfigCatalog).mockResolvedValue({
      ...catalog, driverDefinitions: [{
        ...catalog.driverDefinitions[0]!,
        configSchema: { type: "object", properties: {
          label: { type: "string", description: '<img src=x onerror="window.injected=true">' },
        } },
      }],
    });
    const { container } = render(<ConfigManager disabled={false} onPublished={() => undefined} />);
    await screen.findByRole("button", { name: "新增驱动" });
    fireEvent.click(screen.getByRole("button", { name: "新增驱动" }));
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });

  it("refuses to publish a draft after another manager changes active config", async () => {
    const changed: ManagedConfig = { driverInstances: [
      { id: "new-output", driverType: "virtual", enabled: true, config: {} },
    ], bindings: [] };
    vi.mocked(loadManagedConfig).mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty).mockResolvedValueOnce(changed);
    render(<ConfigManager disabled={false} onPublished={() => undefined} />);
    const previewButton = screen.getByRole("button", { name: "完整校验并预览影响" }) as HTMLButtonElement;
    await waitFor(() => expect(previewButton.disabled).toBe(false));
    fireEvent.click(previewButton);
    await screen.findByText(/Core 校验通过/);
    fireEvent.click(screen.getByRole("button", { name: "发布草案" }));
    await screen.findByText(/CONFIG_CHANGED_RELOAD/);
    expect(publishManagedConfig).not.toHaveBeenCalled();
  });

  it("shows Core validation failure before publication and previews a new rollback revision", async () => {
    const published = vi.fn();
    vi.mocked(previewManagedConfig).mockRejectedValueOnce(new Error("INVALID_ACTION_MAPPING"));
    render(<ConfigManager disabled={false} onPublished={published} />);
    await screen.findByRole("button", { name: "完整校验并预览影响" });
    fireEvent.click(screen.getByRole("button", { name: "完整校验并预览影响" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("INVALID_ACTION_MAPPING");
    expect(screen.queryByRole("button", { name: "发布草案" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看版本" }));
    await screen.findByText(/版本 #1/);
    fireEvent.click(screen.getByRole("button", { name: "回滚并预览" }));
    await waitFor(() => expect(previewRollback).toHaveBeenCalledWith(1));
    await screen.findByText(/回滚自版本 1/);
    fireEvent.click(screen.getByRole("button", { name: "发布草案" }));
    await waitFor(() => expect(publishManagedConfig).toHaveBeenCalledWith(3));
    expect(published).toHaveBeenCalledOnce();
  });
});

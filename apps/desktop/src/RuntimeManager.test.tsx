// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateClaim } from "./api.js";
import "./i18n.js";
import { RuntimeManager } from "./RuntimeManager.js";
import {
  acknowledgeClaim, fetchSupportBundle, loadDiagnosticPreview, saveSupportBundle,
} from "./runtime-management.js";

vi.mock("./runtime-management.js", () => ({
  acknowledgeClaim: vi.fn(), fetchSupportBundle: vi.fn(),
  loadDiagnosticPreview: vi.fn(), saveSupportBundle: vi.fn(),
}));

const claim: StateClaim = {
  producerId: "producer_a", scopeId: "b", signalId: "c",
  value: { phase: "active" }, revision: 17, updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener: vi.fn(),
    removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(acknowledgeClaim).mockResolvedValue();
  vi.mocked(loadDiagnosticPreview).mockResolvedValue({
    files: [{ name: "state-hub-support-bundle.json", containsSecrets: false }],
    redaction: ["claim and action values", "producer token hashes"],
  });
  vi.mocked(fetchSupportBundle).mockResolvedValue('{"schemaVersion":1,"runtime":{}}');
  vi.mocked(saveSupportBundle).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("runtime management", () => {
  it("confirms the exact claim identity and current revision", async () => {
    const changed = vi.fn();
    render(<RuntimeManager claims={[claim]} disabled={false} onChanged={changed} />);
    expect(screen.getByText("17")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认此版本" }));
    await screen.findByText("确认状态版本 17？");
    expect(screen.getByText('["producer_a","b","c"]')).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "确认此版本" }).at(-1)!);
    await waitFor(() => expect(acknowledgeClaim).toHaveBeenCalledWith(claim));
    expect(changed).toHaveBeenCalledOnce();
  });

  it("shows a safe stale-revision code when the claim changes before confirmation", async () => {
    vi.mocked(acknowledgeClaim).mockRejectedValue(new Error("CLAIM_REVISION_MISMATCH"));
    render(<RuntimeManager claims={[claim]} disabled={false} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "确认此版本" }));
    await screen.findByText("确认状态版本 17？");
    fireEvent.click(screen.getAllByRole("button", { name: "确认此版本" }).at(-1)!);
    expect((await screen.findByRole("alert")).textContent).toContain("CLAIM_REVISION_MISMATCH");
  });

  it("shows the file list and redaction summary before export", async () => {
    render(<RuntimeManager claims={[]} disabled={false} onChanged={() => undefined} />);
    expect(screen.queryByRole("button", { name: "选择位置并导出支持包" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看支持包清单与脱敏预览" }));
    await screen.findByText(/state-hub-support-bundle.json/);
    expect(screen.getByText("claim and action values")).toBeTruthy();
    expect(fetchSupportBundle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择位置并导出支持包" }));
    await waitFor(() => expect(saveSupportBundle).toHaveBeenCalledWith(
      '{"schemaVersion":1,"runtime":{}}'));
    await screen.findByText("支持包已保存");
  });

  it("refuses export if preview marks a file as containing secrets", async () => {
    vi.mocked(loadDiagnosticPreview).mockResolvedValue({
      files: [{ name: "unsafe.json", containsSecrets: true }], redaction: [],
    });
    render(<RuntimeManager claims={[]} disabled={false} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "查看支持包清单与脱敏预览" }));
    await screen.findByText(/unsafe.json/);
    expect((screen.getByRole("button", {
      name: "选择位置并导出支持包",
    }) as HTMLButtonElement).disabled).toBe(true);
  });
});

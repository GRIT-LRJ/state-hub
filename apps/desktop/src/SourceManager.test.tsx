// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Modal } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueProducerToken, listProducers, listSources, revokeProducerToken, saveSecret, secretExists } from "./management.js";
import { SourceManager } from "./SourceManager.js";
import { setupDom, renderUi as render } from "./test-support/dom.js";

vi.mock("./management.js", () => ({ issueProducerToken: vi.fn(), listProducers: vi.fn(), listSources: vi.fn(),
  revokeProducerToken: vi.fn(), saveSecret: vi.fn(), secretExists: vi.fn() }));
const producer = { producerId: "source-a", sourceDefinitionId: "official.custom-http", createdAt: "2026-01-01", revokedAt: null };
const codex = { ...producer, producerId: "codex", sourceDefinitionId: "official.codex" };
beforeEach(() => {
  vi.resetAllMocks(); setupDom();
  vi.mocked(listSources).mockResolvedValue([{ id: "official.custom-http", displayNameKey: "custom", eventSchemas: { custom: {} } }]);
  vi.mocked(listProducers).mockResolvedValue([producer]); vi.mocked(issueProducerToken).mockResolvedValue("once-only-token");
  vi.mocked(saveSecret).mockResolvedValue(); vi.mocked(secretExists).mockResolvedValue(true); vi.mocked(revokeProducerToken).mockResolvedValue();
});
afterEach(() => { act(() => Modal.destroyAll()); cleanup(); vi.unstubAllGlobals(); });
const noop = () => undefined;
async function ready(name: string) { await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false)); }

describe("source access", () => {
  it("creates a source-bound token once, and requires an explicit revoke confirmation", async () => {
    render(<SourceManager disabled={false} onPublished={noop} />);
    await ready("添加接入方"); fireEvent.click(screen.getByRole("button", { name: "添加接入方" }));
    fireEvent.change(screen.getByLabelText("生产者 ID"), { target: { value: "new-source" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Token（立即生效）" }));
    await waitFor(() => expect(issueProducerToken).toHaveBeenCalledWith("new-source", "official.custom-http", true));
    expect((await screen.findByLabelText("新生产者 Token") as HTMLInputElement).value).toBe("once-only-token");
    fireEvent.click(screen.getByRole("button", { name: "已保存，关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.queryByLabelText("新生产者 Token") as HTMLInputElement | null)?.value ?? "").not.toBe("once-only-token");
    fireEvent.click(screen.getByRole("button", { name: "撤销 Token" }));
    const dialog = await screen.findByRole("dialog"); expect(revokeProducerToken).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销 Token" }));
    await waitFor(() => expect(revokeProducerToken).toHaveBeenCalledWith("source-a"));
  });

  it("does not rotate existing Codex credentials when resuming setup", async () => {
    vi.mocked(listProducers).mockResolvedValue([codex]);
    render(<SourceManager disabled={false} onPublished={noop} />); await ready("Codex 接入引导");
    fireEvent.click(screen.getByRole("button", { name: "Codex 接入引导" }));
    await screen.findByText(/未轮换 Token/); expect(issueProducerToken).not.toHaveBeenCalled(); expect(saveSecret).not.toHaveBeenCalled();
  });

  it("prepares only Codex access and retains the token when OS storage fails", async () => {
    vi.mocked(saveSecret).mockRejectedValue(new Error("secret-backend-private-detail"));
    render(<SourceManager disabled={false} onPublished={noop} />); await ready("Codex 接入引导");
    fireEvent.click(screen.getByRole("button", { name: "Codex 接入引导" }));
    await waitFor(() => expect(issueProducerToken).toHaveBeenCalledWith("codex", "official.codex", true));
    expect((await screen.findByLabelText("新生产者 Token") as HTMLInputElement).value).toBe("once-only-token");
    await screen.findByText(/操作未完成/); expect(document.body.textContent).not.toContain("secret-backend-private-detail");
  });

  it("requires explicit renewal for a revoked Codex source and closes stale confirmation on disconnect", async () => {
    vi.mocked(listProducers).mockResolvedValue([{ ...codex, revokedAt: "2026-01-02" }]);
    const view = render(<SourceManager disabled={false} onPublished={noop} />); await ready("Codex 接入引导");
    fireEvent.click(screen.getByRole("button", { name: "Codex 接入引导" }));
    await screen.findByRole("dialog"); expect(issueProducerToken).not.toHaveBeenCalled();
    view.rerender(<SourceManager disabled onPublished={noop} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(issueProducerToken).not.toHaveBeenCalled();
  });

  it("recovers a failed initial read without mutating credentials", async () => {
    vi.mocked(listSources).mockRejectedValueOnce(new Error("read failed"));
    render(<SourceManager disabled={false} onPublished={noop} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新读取接入方" }));
    await ready("添加接入方"); expect(screen.getByText("source-a")).toBeTruthy();
    expect(issueProducerToken).not.toHaveBeenCalled();
  });
});

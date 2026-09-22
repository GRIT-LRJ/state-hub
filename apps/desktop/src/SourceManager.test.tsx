// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./i18n.js";
import {
  issueProducerToken, listProducers, listSources, preparePushPlus, publishConfig,
  removeSecret, revokeProducerToken, saveSecret, secretExists,
} from "./management.js";
import { SourceManager } from "./SourceManager.js";

vi.mock("./management.js", () => ({
  issueProducerToken: vi.fn(), listProducers: vi.fn(), listSources: vi.fn(),
  preparePushPlus: vi.fn(), publishConfig: vi.fn(), removeSecret: vi.fn(),
  revokeProducerToken: vi.fn(), saveSecret: vi.fn(), secretExists: vi.fn(),
}));

const producer = { producerId: "source-a", sourceDefinitionId: "official.custom-http",
  createdAt: "2026-01-01T00:00:00Z", revokedAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener: vi.fn(),
    removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.mocked(listSources).mockResolvedValue([{ id: "official.custom-http",
    displayNameKey: "source.custom.name", eventSchemas: { custom: {} } }]);
  vi.mocked(listProducers).mockResolvedValue([producer]);
  vi.mocked(issueProducerToken).mockResolvedValue("one-time-producer-token");
  vi.mocked(saveSecret).mockResolvedValue();
  vi.mocked(removeSecret).mockResolvedValue();
  vi.mocked(secretExists).mockResolvedValue(true);
  vi.mocked(preparePushPlus).mockResolvedValue({ revision: 42, impact: { deliveries: 0 } });
  vi.mocked(publishConfig).mockResolvedValue();
  vi.mocked(revokeProducerToken).mockResolvedValue();
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("desktop source and credential management", () => {
  it("creates a source-bound token, shows it once, and revokes access", async () => {
    render(<SourceManager disabled={false} onPublished={() => undefined} />);
    await screen.findByText(/source-a · official.custom-http/);
    fireEvent.change(screen.getAllByLabelText("生产者 ID")[0]!, { target: { value: "new-source" } });
    fireEvent.click(screen.getByRole("button", { name: "创建或轮换 Token" }));
    await waitFor(() => expect(issueProducerToken).toHaveBeenCalledWith("new-source", "official.custom-http"));
    expect((screen.getByLabelText("新生产者 Token") as HTMLInputElement).value).toBe("one-time-producer-token");
    fireEvent.click(screen.getByRole("button", { name: "已保存，关闭" }));
    expect(screen.queryByLabelText("新生产者 Token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤销 Token" }));
    await waitFor(() => expect(revokeProducerToken).toHaveBeenCalledWith("source-a"));
  });

  it("saves and clears secrets without echoing them, and hides read failures", async () => {
    render(<SourceManager disabled={false} onPublished={() => undefined} />);
    await screen.findByText(/source-a · official.custom-http/);
    fireEvent.change(screen.getByLabelText("密钥"), { target: { value: "private-key-material" } });
    fireEvent.click(screen.getByRole("button", { name: "保存或替换密钥" }));
    await waitFor(() => expect(saveSecret).toHaveBeenCalledWith("pushplus:main", "private-key-material"));
    expect((screen.getByLabelText("密钥") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("private-key-material");
    vi.mocked(secretExists).mockRejectedValueOnce(new Error("untrusted keyring error with private-key-material"));
    fireEvent.click(screen.getByRole("button", { name: "检查是否存在" }));
    await screen.findByText(/操作未完成/);
    expect(document.body.textContent).not.toContain("private-key-material");
    fireEvent.click(screen.getByRole("button", { name: "删除密钥" }));
    await waitFor(() => expect(removeSecret).toHaveBeenCalledWith("pushplus:main"));
    vi.mocked(saveSecret).mockRejectedValueOnce(new Error("untrusted save error with private-key-material"));
    fireEvent.change(screen.getByLabelText("密钥"), { target: { value: "private-key-material" } });
    fireEvent.click(screen.getByRole("button", { name: "保存或替换密钥" }));
    await screen.findByText(/操作未完成/);
    expect(document.body.textContent).not.toContain("private-key-material");
    expect(screen.getByText("系统凭据库中没有此引用")).toBeTruthy();
  });

  it("previews and publishes PushPlus only with a present credential", async () => {
    const onPublished = vi.fn();
    render(<SourceManager disabled={false} onPublished={onPublished} />);
    await screen.findByText(/source-a · official.custom-http/);
    fireEvent.click(screen.getByRole("button", { name: "预览 PushPlus 配置" }));
    await waitFor(() => expect(preparePushPlus).toHaveBeenCalledWith(expect.objectContaining({
      producerId: "source-a", tokenSecretRef: "pushplus:main", contentPointer: "/content",
    })));
    await screen.findByText(/"deliveries": 0/);
    fireEvent.click(screen.getByRole("button", { name: "发布配置" }));
    await waitFor(() => expect(publishConfig).toHaveBeenCalledWith(42));
    expect(onPublished).toHaveBeenCalledOnce();
  });
});

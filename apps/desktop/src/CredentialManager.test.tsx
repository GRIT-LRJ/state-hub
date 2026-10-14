// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Modal } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeSecret, saveSecret, secretExists } from "./management.js";
import { CredentialManager } from "./CredentialManager.js";
import { setupDom, renderUi as render } from "./test-support/dom.js";
vi.mock("./management.js", () => ({ removeSecret: vi.fn(), saveSecret: vi.fn(), secretExists: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); setupDom(); vi.mocked(saveSecret).mockResolvedValue(); vi.mocked(removeSecret).mockResolvedValue(); vi.mocked(secretExists).mockResolvedValue(true); });
afterEach(() => { act(() => Modal.destroyAll()); cleanup(); vi.unstubAllGlobals(); });

it("checks references without losing typed secrets, clears successful saves, and requires deletion confirmation", async () => {
  const saved = vi.fn(); render(<CredentialManager disabled={false} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("密钥"), { target: { value: "private-key-material" } });
  fireEvent.click(screen.getByRole("button", { name: "检查是否存在" })); await screen.findByText("系统凭据库中存在此引用");
  expect((screen.getByLabelText("密钥") as HTMLInputElement).value).toBe("private-key-material");
  fireEvent.click(screen.getByRole("button", { name: "保存或替换密钥" })); await waitFor(() => expect(saved).toHaveBeenCalledWith("pushplus:main"));
  expect(saveSecret).toHaveBeenCalledWith("pushplus:main", "private-key-material");
  expect((screen.getByLabelText("密钥") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "删除密钥" })); const dialog = await screen.findByRole("dialog");
  expect(removeSecret).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole("button", { name: "删除密钥" }));
  await waitFor(() => expect(removeSecret).toHaveBeenCalledWith("pushplus:main"));
});

it("shows a safe failure and preserves input so a failed save can be retried", async () => {
  vi.mocked(saveSecret).mockRejectedValueOnce(new Error("private-key-material")); render(<CredentialManager disabled={false} />);
  fireEvent.change(screen.getByLabelText("密钥"), { target: { value: "private-key-material" } });
  fireEvent.click(screen.getByRole("button", { name: "保存或替换密钥" })); await screen.findByText(/凭据操作失败/);
  expect(document.body.textContent).not.toContain("private-key-material");
  expect((screen.getByLabelText("密钥") as HTMLInputElement).value).toBe("private-key-material");
  fireEvent.click(screen.getByRole("button", { name: "保存或替换密钥" })); await screen.findByText(/密钥已保存并立即生效/);
});

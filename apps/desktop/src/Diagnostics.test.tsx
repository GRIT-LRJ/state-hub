// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Diagnostics } from "./Diagnostics.js";
import { fetchSupportBundle, parseDiagnosticDeliveries, saveSupportBundle } from "./runtime-management.js";
import { setupDom, renderUi as render } from "./test-support/dom.js";
import "./i18n.js";
vi.mock("./runtime-management.js", async (original) => ({ ...await original<typeof import("./runtime-management.js")>(),
  fetchSupportBundle: vi.fn(), saveSupportBundle: vi.fn() }));
const delivery = { deliveryId: "sha256:delivery", driverInstanceId: "sha256:driver", status: "dead-letter", actionKind: "append-only",
  attemptCount: 3, lastError: "HTTP 503", createdAt: "2026-10-13T01:00:00Z", completedAt: null };
const bundle = JSON.stringify({ schemaVersion: 1, generatedAt: "2026-10-13T02:00:00Z", deliveries: [delivery] });
beforeEach(() => { vi.resetAllMocks(); setupDom(); vi.mocked(fetchSupportBundle).mockResolvedValue(bundle); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("loads recent redacted deliveries only on demand and never saves a support file", async () => {
  render(<Diagnostics disabled={false} pending={1} failed={1000} />);
  expect(fetchSupportBundle).not.toHaveBeenCalled(); expect(screen.getByText(/不是完整历史/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加载最近投递" }));
  await waitFor(() => expect(screen.getByText("append-only")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /expand row/i }));
  expect(screen.getByText(/HTTP 503/)).toBeTruthy(); expect(saveSupportBundle).not.toHaveBeenCalled();
});

it("limits rows and withholds unknown error details", () => {
  const data = parseDiagnosticDeliveries(JSON.stringify({ schemaVersion: 1, generatedAt: "now", deliveries: Array.from({ length: 501 }, () => ({ ...delivery, lastError: "private password value" })) }));
  expect(data.deliveries).toHaveLength(500); expect(data.deliveries[0]?.lastError).toBe("Driver error details withheld");
  expect(() => parseDiagnosticDeliveries('{"schemaVersion":2}')).toThrow("INVALID_SUPPORT_BUNDLE");
  expect(() => parseDiagnosticDeliveries('{"schemaVersion":1,"generatedAt":"now","deliveries":[null]}')).toThrow("INVALID_SUPPORT_BUNDLE");
});

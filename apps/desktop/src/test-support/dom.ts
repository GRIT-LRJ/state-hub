import { vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { ConfigProvider } from "antd";
import { render } from "@testing-library/react";

export function renderUi(ui: ReactElement) {
  return render(ui, { wrapper: ({ children }: { children: ReactNode }) =>
    createElement(ConfigProvider, { theme: { token: { motion: false } }, wave: { disabled: true } }, children) });
}

export function setupDom() {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const computed = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (element: Element) => computed(element));
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

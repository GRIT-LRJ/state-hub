import { expect, it } from "vitest";
import { loadConfig, validateDesktopDevOrigin } from "./config.js";

it("keeps development desktop origins explicit and independent of plugin mode", () => {
  const env = { STATE_HUB_ADMIN_TOKEN: "x".repeat(32), STATE_HUB_PLUGIN_DEVELOPMENT_MODE: "true" };
  expect(loadConfig(env).desktopDevOrigin).toBeUndefined();
  expect(loadConfig({ ...env, STATE_HUB_DESKTOP_DEV_ORIGIN: "" }).desktopDevOrigin).toBeUndefined();
  expect(loadConfig({ ...env, STATE_HUB_DESKTOP_DEV_ORIGIN: "http://localhost:1420" }).desktopDevOrigin)
    .toBe("http://localhost:1420");
});

it.each(["http://localhost:1420", "https://127.0.0.1:1420", "http://[::1]:1420"])("accepts an exact loopback origin: %s", (origin) => {
  expect(validateDesktopDevOrigin(origin)).toBe(origin);
});

it.each(["*", "null", "file:///app", "http://example.com:1420", "http://localhost.evil:1420",
  "http://0.0.0.0:1420", "http://user:secret@localhost:1420", "http://localhost:1420/",
  "http://localhost:1420/path", "http://localhost:1420?key=secret", "http://localhost:1420#hash"])
  ("rejects non-origin or non-loopback development settings: %s", (origin) => {
    expect(() => validateDesktopDevOrigin(origin)).toThrow("INVALID_DESKTOP_DEV_ORIGIN");
  });

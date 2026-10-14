import assert from "node:assert/strict";
import { test } from "node:test";
import { stableConfig } from "./stable-config.mjs";

const common = { TAURI_SIGNING_PRIVATE_KEY: "test-private-key", STATE_HUB_UPDATER_PUBLIC_KEY: "test-public-key" };

test("stable Windows build requires an actual certificate identity and timestamp URL", () => {
  const windows = { ...common, WINDOWS_CERTIFICATE_BASE64: "test-certificate",
    WINDOWS_CERTIFICATE_PASSWORD: "test-password", STATE_HUB_WINDOWS_THUMBPRINT: "a".repeat(40),
    WINDOWS_TIMESTAMP_URL: "https://timestamp.example.com" };
  assert.equal(stableConfig("windows", windows).bundle.windows.certificateThumbprint, "a".repeat(40));
  assert.throws(() => stableConfig("windows", { ...windows, STATE_HUB_WINDOWS_THUMBPRINT: "broken" }));
  assert.throws(() => stableConfig("windows", { ...windows, WINDOWS_TIMESTAMP_URL: "file:///tmp/clock" }));
});

test("stable macOS build requires Developer ID; Linux uses signed updater", () => {
  const mac = { ...common, APPLE_CERTIFICATE: "test-certificate", APPLE_CERTIFICATE_PASSWORD: "test-password",
    APPLE_ID: "test-id", APPLE_PASSWORD: "test-app-password", APPLE_TEAM_ID: "TESTTEAM",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (TESTTEAM)" };
  assert.equal(stableConfig("darwin", mac).bundle.macOS.signingIdentity, mac.APPLE_SIGNING_IDENTITY);
  assert.throws(() => stableConfig("darwin", { ...mac, APPLE_SIGNING_IDENTITY: "-" }));
  assert.equal(stableConfig("linux", common).bundle.createUpdaterArtifacts, true);
});

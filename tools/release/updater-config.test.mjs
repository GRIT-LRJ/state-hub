import assert from "node:assert/strict";
import { test } from "node:test";
import { updaterConfig } from "./updater-config.mjs";

test("signed release uses a channel-specific HTTPS manifest", () => {
  const config = updaterConfig({ channel: "stable", publicKey: "test-public-key" });
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/GRIT-LRJ/state-hub/releases/latest/download/latest.json",
  ]);
  assert.equal(config.plugins.updater.pubkey, "test-public-key");
  assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol, undefined);
});

test("unknown channels, absent keys, insecure endpoints and embedded credentials fail closed", () => {
  for (const options of [
    { channel: "other", publicKey: "key" },
    { channel: "stable", publicKey: "" },
    { channel: "stable", publicKey: "key", baseUrl: "http://example.com" },
    { channel: "stable", publicKey: "key", baseUrl: "https://user:secret@example.com" },
    { channel: "stable", publicKey: "key", baseUrl: "https://example.com", localSmoke: true },
  ]) {
    assert.throws(() => updaterConfig(options));
  }
  const smoke = updaterConfig({ channel: "beta", publicKey: "test-key", baseUrl: "http://127.0.0.1:1234", localSmoke: true });
  assert.equal(smoke.plugins.updater.dangerousInsecureTransportProtocol, true);
  assert.equal(updaterConfig({ channel: "beta", publicKey: "test-key", version: "0.0.1" }).version, "0.0.1");
  assert.throws(() => updaterConfig({ channel: "beta", publicKey: "test-key", version: "bad" }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReleaseCredentials, checkStablePolicy } from "./stable-policy.mjs";

const allPassed = Array.from({ length: 23 }, (_, index) =>
  `| #${index + 1} item | PASS | gate | ${index ? "abcdef1" : "—"} |`).join("\n");

test("stable gate requires the full product acceptance chain at this HEAD", () => {
  assert.doesNotThrow(() => checkStablePolicy(allPassed, "1.2.3", "1.2.3", () => true));
  assert.throws(() => checkStablePolicy(allPassed, "1.2.3-beta.1", "1.2.3-beta.1"));
  assert.throws(() => checkStablePolicy(allPassed, "1.2.4", "1.2.3"));
  assert.throws(() => checkStablePolicy(allPassed, "1.2.3", "1.2.3", () => false));
  assert.throws(() => checkStablePolicy(allPassed.replace("| #8 item | PASS", "| #8 item | BLOCKED"), "1.2.3", "1.2.3"));
  assert.throws(() => checkStablePolicy(allPassed.replace("| #23 item | PASS", "| #23 item | TODO"), "1.2.3", "1.2.3"));
});

test("missing platform signing and notarization credentials fail closed", () => {
  const updater = { TAURI_SIGNING_PRIVATE_KEY: "test-key", STATE_HUB_UPDATER_PUBLIC_KEY: "test-public-key" };
  assert.doesNotThrow(() => checkReleaseCredentials("linux", updater));
  assert.throws(() => checkReleaseCredentials("windows", updater), /WINDOWS_CERTIFICATE_BASE64/);
  assert.throws(() => checkReleaseCredentials("darwin", updater), /APPLE_CERTIFICATE/);
  assert.throws(() => checkReleaseCredentials("other", updater));
});

test("only explicitly deferred performance targets are exempt from the stable gate", () => {
  const deferred = allPassed.replace("| #22 item | PASS", "| #22 item | DEFERRED");
  assert.doesNotThrow(() => checkStablePolicy(deferred, "1.2.3", "1.2.3"));
  for (const status of ["TODO", "FAIL", "BLOCKED"]) {
    assert.throws(() => checkStablePolicy(allPassed.replace("| #22 item | PASS", `| #22 item | ${status}`), "1.2.3", "1.2.3"));
  }
  for (const issue of [1, 8, 16, 23]) {
    assert.throws(() => checkStablePolicy(deferred.replace(`| #${issue} item | PASS`, `| #${issue} item | DEFERRED`), "1.2.3", "1.2.3"));
  }
  assert.throws(() => checkStablePolicy(deferred.replace(/^.*#22 item.*$/m, ""), "1.2.3", "1.2.3"));
});

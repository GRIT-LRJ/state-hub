import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseManifest, UPDATE_TARGETS } from "./manifest.mjs";

const entries = Object.fromEntries(UPDATE_TARGETS.map((target) => [target, {
  url: `https://github.com/GRIT-LRJ/state-hub/releases/download/v1.2.3/${target}.zip`,
  signature: `signature-${target}`,
}]));

test("complete manifest keeps four signed platform identities", () => {
  const manifest = releaseManifest("1.2.3", entries);
  assert.deepEqual(Object.keys(manifest.platforms), UPDATE_TARGETS);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "signature-darwin-aarch64");
});

test("incomplete, malformed and insecure manifests fail", () => {
  const { [UPDATE_TARGETS[0]]: _missing, ...partial } = entries;
  assert.throws(() => releaseManifest("1.2.3", partial));
  assert.throws(() => releaseManifest("bad", entries));
  assert.throws(() => releaseManifest("1.2.3", { ...entries, "linux-x86_64": { ...entries["linux-x86_64"], signature: "" } }));
  assert.throws(() => releaseManifest("1.2.3", { ...entries, "linux-x86_64": { ...entries["linux-x86_64"], url: "http://example.com/file" } }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableArtifacts, stableMetadata } from "./stable-artifacts.mjs";

test("stable metadata requires all four signed updater artifacts and a Linux deb", () => {
  const root = mkdtempSync(join(tmpdir(), "state-hub-stable-artifacts-"));
  try {
    const samples = [
      ["windows-x86_64", "nsis", "State Hub_1.2.3_x64-setup.exe"],
      ["darwin-x86_64", "macos", "State Hub.app.tar.gz"],
      ["darwin-aarch64", "macos", "State Hub.app.tar.gz"],
      ["linux-x86_64", "appimage", "state-hub_1.2.3_amd64.AppImage"],
    ];
    for (const [target, directory, name] of samples) {
      const path = join(root, `stable-candidate-${target}`, directory);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, name), target);
      writeFileSync(join(path, `${name}.sig`), `signature-${target}`);
    }
    const debDir = join(root, "stable-candidate-linux-x86_64", "deb");
    mkdirSync(debDir);
    writeFileSync(join(debDir, "state-hub_1.2.3_amd64.deb"), "deb-content");
    const artifacts = stableArtifacts(root, "1.2.3");
    const metadata = stableMetadata("1.2.3", artifacts, join(root, "release-files"));
    assert.equal(Object.keys(metadata.manifest.platforms).length, 4);
    assert.equal(metadata.checksums.trim().split("\n").length, 5);
    assert.match(metadata.manifest.platforms["darwin-aarch64"].url, /v1\.2\.3/);
    assert.notEqual(metadata.manifest.platforms["darwin-aarch64"].url,
      metadata.manifest.platforms["darwin-x86_64"].url);
    assert.equal(metadata.manifest.platforms["windows-x86_64"].signature,
      "signature-windows-x86_64");
    writeFileSync(`${artifacts["linux-x86_64"].file}.sig`, "");
    assert.throws(() => stableArtifacts(root, "1.2.3"), /Missing linux-x86_64/);
    assert.throws(() => stableArtifacts(root, "1.2.4"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

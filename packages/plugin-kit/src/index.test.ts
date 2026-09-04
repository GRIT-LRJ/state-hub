import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packPlugin, verifyPlugin } from "./index.js";

function fixture(): { root: string; privateKey: string; publicKey: string } {
  const root = mkdtempSync(join(tmpdir(), "state-hub-plugin-"));
  mkdirSync(join(root, "schemas"));
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      id: "example.test",
      version: "1.0.0",
      protocolVersion: "1.0",
      publisher: "example",
      license: "MIT",
      entrypoints: { win32: "plugin.exe" },
    }),
  );
  writeFileSync(join(root, "LICENSE"), "MIT");
  writeFileSync(join(root, "schemas", "config.json"), '{"type":"object"}');
  const pair = generateKeyPairSync("ed25519");
  return {
    root,
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe(".statehub-plugin supply chain", () => {
  it("packs deterministically and verifies checksums and Ed25519 publisher trust", () => {
    const source = fixture();
    const first = packPlugin(source.root, source.privateKey);
    const second = packPlugin(source.root, source.privateKey);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const verified = verifyPlugin(first, new Map([["example", source.publicKey]]));
    expect(verified.manifest.id).toBe("example.test");
    expect(verified.signed).toBe(true);
  });

  it("rejects an untrusted publisher", () => {
    const source = fixture();
    expect(() => verifyPlugin(packPlugin(source.root, source.privateKey), new Map())).toThrow(/not trusted/u);
  });
});

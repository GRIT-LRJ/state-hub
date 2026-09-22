import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
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
  writeFileSync(join(root, "plugin.exe"), "test fixture");
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


  it("rejects changed bytes and unsafe archive paths before trusting a package", () => {
    const source = fixture();
    const files = unzipSync(packPlugin(source.root, source.privateKey));
    files["plugin.exe"] = Buffer.from("tampered");
    expect(() => verifyPlugin(zipSync(files), new Map([["example", source.publicKey]]))).toThrow(/checksum mismatch/u);
    expect(() => verifyPlugin(zipSync({ "../escape": Buffer.from("bad") }), new Map()))
      .toThrow(/Unsafe plugin archive path/u);
    expect(() => verifyPlugin(zipSync({ "../": Buffer.from("") }), new Map()))
      .toThrow(/Unsafe plugin archive path/u);
    expect(() => verifyPlugin(zipSync({ "CON.txt": Buffer.from("bad") }), new Map()))
      .toThrow(/Unsafe plugin archive path/u);
  });

  it("accepts unsigned archives only with explicit development mode", () => {
    const source = fixture();
    const files = unzipSync(packPlugin(source.root, source.privateKey));
    delete files["signature.json"];
    const unsigned = zipSync(files);
    expect(() => verifyPlugin(unsigned, new Map())).toThrow(/development mode/u);
    expect(verifyPlugin(unsigned, new Map(), { developmentMode: true }).signed).toBe(false);
  });

  it("rejects missing license, platform entrypoint and invalid definition manifests", () => {
    const source = fixture();
    writeFileSync(join(source.root, "manifest.json"), JSON.stringify({
      id: "example.test", version: "1.0.0", protocolVersion: "1.0",
      publisher: "example", license: "MIT", entrypoints: { win32: "../outside.exe" },
    }));
    expect(() => packPlugin(source.root, source.privateKey)).toThrow(/entrypoint/u);
    writeFileSync(join(source.root, "manifest.json"), JSON.stringify({
      id: "example.test", version: "1.0.0", protocolVersion: "1.0",
      publisher: "example", license: "MIT", entrypoints: { win32: "plugin.exe" },
      sourceDefinitions: ["schemas/missing.json"],
    }));
    expect(() => packPlugin(source.root, source.privateKey)).toThrow(/definition file/u);
    writeFileSync(join(source.root, "schemas", "missing.json"), '{"id":"source"}');
    expect(() => packPlugin(source.root, source.privateKey)).toThrow(/definition is invalid/u);
    writeFileSync(join(source.root, "manifest.json"), JSON.stringify({
      id: "example.test", version: "1.0.0", protocolVersion: "1.0",
      publisher: "example", license: "MIT", entrypoints: { win32: "plugin.exe" },
    }));
    rmSync(join(source.root, "LICENSE"));
    expect(() => packPlugin(source.root, source.privateKey)).toThrow(/license/u);
  });
});

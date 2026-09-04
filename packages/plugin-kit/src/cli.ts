#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packPlugin, verifyPlugin } from "./index.js";

function requireArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function main(): void {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "pack") {
    const source = resolve(requireArgument(first, "source directory"));
    const output = resolve(requireArgument(second, "output .statehub-plugin path"));
    if (!output.endsWith(".statehub-plugin")) throw new Error("Output must use the .statehub-plugin extension");
    const privateKey = readFileSync(resolve(requireArgument(third, "Ed25519 private key PEM")), "utf8");
    const temporary = `${output}.${process.pid}.tmp`;
    writeFileSync(temporary, packPlugin(source, privateKey), { mode: 0o600 });
    renameSync(temporary, output);
    process.stdout.write(`${output}\n`);
    return;
  }
  if (command === "verify") {
    const archive = readFileSync(resolve(requireArgument(first, "archive")));
    const publisher = requireArgument(second, "publisher id");
    const publicKey = readFileSync(resolve(requireArgument(third, "Ed25519 public key PEM")), "utf8");
    const verified = verifyPlugin(archive, new Map([[publisher, publicKey]]));
    process.stdout.write(
      `${JSON.stringify({ id: verified.manifest.id, version: verified.manifest.version, publisher, signed: true })}\n`,
    );
    return;
  }
  throw new Error(
    "Usage: state-hub-plugin pack DIR OUTPUT.statehub-plugin PRIVATE_KEY.pem | verify ARCHIVE PUBLISHER PUBLIC_KEY.pem",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

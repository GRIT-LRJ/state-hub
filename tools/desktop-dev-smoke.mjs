// Own the Vite server; never reuse an existing development session as test evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const executable = process.argv[2];
if (!executable) throw new Error("Expected a lifecycle-smoke executable built without custom-protocol");
const origin = process.argv[3] ?? "http://localhost:1420";
const url = new URL(origin);
assert.equal(url.origin, origin);
assert.equal(url.hostname, "localhost");
assert.equal(url.protocol, "http:");
const desktop = resolve(root, "apps/desktop");
const { createServer } = await import(pathToFileURL(resolve(desktop, "node_modules/vite/dist/node/index.js")).href);
const server = await createServer({ root: desktop, configFile: resolve(desktop, "vite.config.ts"),
  define: { "import.meta.env.VITE_STATE_HUB_LIFECYCLE_SMOKE": JSON.stringify("1") },
  server: { host: "localhost", port: Number(url.port || 80), strictPort: true },
});
try {
  await server.listen(); // Occupied port is a failure, not permission to attach to another session.
  const child = spawn(process.execPath, [resolve(root, "tools/desktop-lifecycle-smoke.mjs"), resolve(executable), origin],
    { stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 1));
  });
} finally { await server.close(); }

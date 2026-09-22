import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginProcess, PluginSupervisor } from "./plugin-host.js";

function makeChild(mode: "valid" | "timeout" | "invalid" | "unknown" | "missing-result"): { directory: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "statehub-plugin-host-test-"));
  const script = join(directory, "plugin.mjs");
  writeFileSync(script, `
let buffer = Buffer.alloc(0);
function send(id, result) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf("\\r\\n\\r\\n");
    if (boundary < 0) return;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, boundary).toString())?.[1]);
    if (buffer.length < boundary + 4 + length) return;
    const request = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString());
    buffer = buffer.subarray(boundary + 4 + length);
    if (request.method === "statehub.initialize") {
      send(request.id, { protocolVersion: "1.0", sourceDefinitions: [], driverDefinitions: [] });
    } else if (request.method === "statehub.stop") {
      send(request.id, { stopped: true });
    } else if (${JSON.stringify(mode)} === "invalid") {
      process.stdout.write("Broken: 1\\r\\n\\r\\n{}");
    } else if (${JSON.stringify(mode)} === "unknown") {
      send("not-the-request-id", { status: "ok" });
    } else if (${JSON.stringify(mode)} === "missing-result") {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id }));
      process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
    } else if (${JSON.stringify(mode)} === "valid") {
      send(request.id, { status: "ok" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);
  return { directory, script };
}

describe("plugin child process isolation", () => {
  it("handshakes, answers framed calls and stops cleanly", async () => {
    const child = makeChild("valid");
    const supervisor = new PluginSupervisor();
    try {
      const started = await supervisor.start("fixture", process.execPath, [child.script], child.directory);
      expect(started.handshake).toMatchObject({ protocolVersion: "1.0" });
      expect(await started.process.health()).toEqual({ status: "ok" });
      expect(supervisor.get("fixture")?.pid).toBeTypeOf("number");
    } finally {
      await supervisor.stopAll();
      rmSync(child.directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["timeout", "RPC_TIMEOUT"],
    ["invalid", "INVALID_FRAME"],
    ["unknown", "UNKNOWN_RESPONSE"],
    ["missing-result", "INVALID_RESPONSE"],
  ] as const)("contains a %s child response", async (mode, reason) => {
    const child = makeChild(mode);
    const processHandle = new PluginProcess(process.execPath, [child.script], child.directory);
    try {
      await expect(processHandle.call("probe", {}, mode === "timeout" ? 100 : 1_000)).rejects.toThrow();
      expect(processHandle.closed).toBe(true);
      expect(processHandle.failureCode).toBe(reason);
    } finally {
      await processHandle.close();
      rmSync(child.directory, { recursive: true, force: true });
    }
  });

  it("contains spawn failures without an unhandled child error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "statehub-plugin-host-test-"));
    const processHandle = new PluginProcess(join(directory, "missing-program"), [], directory);
    try {
      await expect(processHandle.call("probe", {}, 100)).rejects.toThrow();
      expect(processHandle.failureCode).toBe("SPAWN_FAILED");
    } finally {
      await processHandle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

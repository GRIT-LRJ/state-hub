import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JsonRpcRequest, JsonRpcResponse } from "@state-hub/protocol";
import { PLUGIN_PROTOCOL_VERSION } from "@state-hub/protocol";
import { encodeFrame, FrameDecoder } from "@state-hub/sdk";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PluginProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string | number, PendingRequest>();
  #closed = false;

  constructor(command: string, args: string[], cwd: string) {
    this.#child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMP: process.env.TMP, TEMP: process.env.TEMP },
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.handle(message as JsonRpcResponse);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        this.#child.kill();
      }
    });
    this.#child.on("exit", (code) => {
      this.#closed = true;
      this.failAll(new Error(`Plugin process exited with code ${code ?? "unknown"}`));
    });
  }

  async initialize(): Promise<unknown> {
    return await this.call("statehub.initialize", { protocolVersion: PLUGIN_PROTOCOL_VERSION, hostVersion: "0.1.0" });
  }

  async health(): Promise<unknown> {
    return await this.call("statehub.health", undefined, 2_000);
  }

  async call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.#closed) throw new Error("Plugin process is closed");
    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Plugin RPC timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(encodeFrame(request));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.call("statehub.stop", undefined, 2_000);
    } finally {
      this.#closed = true;
      this.#child.kill();
    }
  }

  private handle(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export class PluginSupervisor {
  readonly #processes = new Map<string, PluginProcess>();

  async start(packageId: string, command: string, args: string[], cwd: string): Promise<PluginProcess> {
    if (this.#processes.has(packageId)) throw new Error(`Plugin package already running: ${packageId}`);
    const process = new PluginProcess(command, args, cwd);
    await process.initialize();
    this.#processes.set(packageId, process);
    return process;
  }

  async stop(packageId: string): Promise<void> {
    const process = this.#processes.get(packageId);
    if (!process) return;
    this.#processes.delete(packageId);
    await process.close();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#processes.keys()].map(async (id) => await this.stop(id)));
  }
}

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
  readonly #exitPromise: Promise<void>;
  #closed = false;
  #failureCode: string | undefined;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private readonly onFailure?: (code: string) => void,
  ) {
    this.#child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMP: process.env.TMP, TEMP: process.env.TEMP },
    });
    this.#exitPromise = new Promise((resolve) => this.#child.once("close", () => resolve()));
    this.#child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.handle(message);
      } catch {
        this.fail("INVALID_FRAME");
      }
    });
    // Plugin stderr is untrusted. Drain it so a noisy plugin cannot block, but never log its body.
    this.#child.stderr.on("data", () => undefined);
    this.#child.stdin.on("error", () => this.fail("PIPE_FAILED"));
    this.#child.on("error", () => this.fail("SPAWN_FAILED"));
    this.#child.on("exit", () => this.fail("PROCESS_EXITED"));
  }

  get closed(): boolean { return this.#closed; }
  get failureCode(): string | undefined { return this.#failureCode; }
  get pid(): number | undefined { return this.#child.pid; }

  async initialize(): Promise<unknown> {
    return await this.call("statehub.initialize", { protocolVersion: PLUGIN_PROTOCOL_VERSION, hostVersion: "0.1.0" }, 2_000);
  }

  async health(): Promise<unknown> {
    return await this.call("statehub.health", undefined, 2_000);
  }

  async call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.#closed) throw new Error(this.#failureCode ?? "PLUGIN_UNAVAILABLE");
    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("RPC_TIMEOUT"), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#child.stdin.write(encodeFrame(request)); }
      catch { this.fail("PIPE_FAILED"); }
    });
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      try { await this.call("statehub.stop", undefined, 2_000); }
      catch { /* The process is killed below even when its stop handler fails. */ }
      this.#closed = true;
      this.#child.kill();
      this.failAll(new Error("PLUGIN_STOPPED"));
    }
    await this.waitForExit();
  }

  private async waitForExit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const exited = await Promise.race([
        this.#exitPromise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
      if (!exited) {
        this.#child.kill("SIGKILL");
        let forceTimer: NodeJS.Timeout | undefined;
        try {
          const killed = await Promise.race([
            this.#exitPromise.then(() => true),
            new Promise<false>((resolve) => { forceTimer = setTimeout(() => resolve(false), 2_000); }),
          ]);
          if (!killed) throw new Error("PLUGIN_EXIT_TIMEOUT");
        } finally {
          if (forceTimer) clearTimeout(forceTimer);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handle(value: unknown): void {
    if (!value || typeof value !== "object") { this.fail("INVALID_RESPONSE"); return; }
    const response = value as Partial<JsonRpcResponse>;
    if (response.jsonrpc !== "2.0" ||
      (typeof response.id !== "string" && typeof response.id !== "number") ||
      (Object.hasOwn(response, "error") === Object.hasOwn(response, "result")) ||
      (response.error !== undefined &&
        (!response.error || typeof response.error.code !== "number" || typeof response.error.message !== "string"))) {
      this.fail("INVALID_RESPONSE");
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) { this.fail("UNKNOWN_RESPONSE"); return; }
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    if (response.error) pending.reject(new Error("PLUGIN_RPC_ERROR"));
    else pending.resolve(response.result);
  }

  private fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failureCode = code;
    this.failAll(new Error(code));
    this.#child.kill();
    this.onFailure?.(code);
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

  async start(
    packageId: string,
    command: string,
    args: string[],
    cwd: string,
    onFailure?: (code: string) => void,
  ): Promise<{ process: PluginProcess; handshake: unknown }> {
    const existing = this.#processes.get(packageId);
    if (existing && !existing.closed) throw new Error("Plugin package is already running");
    if (existing?.closed) this.#processes.delete(packageId);
    const process = new PluginProcess(command, args, cwd, onFailure);
    try {
      const handshake = await process.initialize();
      if (process.closed) throw new Error(process.failureCode ?? "PLUGIN_UNAVAILABLE");
      this.#processes.set(packageId, process);
      return { process, handshake };
    } catch (error) {
      await process.close();
      throw error;
    }
  }

  replace(packageId: string, next: PluginProcess): PluginProcess | undefined {
    if (next.closed) throw new Error("PLUGIN_UNAVAILABLE");
    const previous = this.#processes.get(packageId);
    this.#processes.set(packageId, next);
    return previous;
  }

  get(packageId: string): PluginProcess | undefined {
    const process = this.#processes.get(packageId);
    return process?.closed ? undefined : process;
  }

  async stop(packageId: string): Promise<void> {
    const process = this.#processes.get(packageId);
    if (!process) return;
    this.#processes.delete(packageId);
    await process.close();
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.#processes.keys()].map(async (id) => await this.stop(id)));
  }
}

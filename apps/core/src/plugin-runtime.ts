import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { stableStringify } from "@state-hub/domain";
import { PLUGIN_PROTOCOL_VERSION, type DriverActionRequest, type DriverActionResult } from "@state-hub/protocol";
import { PluginSupervisor } from "./plugin-host.js";
import type { PluginRepository } from "./plugin-repository.js";

type RuntimeState = "running" | "failed" | "stopped";
export interface PluginRuntimeStatus {
  id: string;
  status: RuntimeState;
  reasonCode?: string;
  pid?: number;
}

export class PluginRuntime {
  readonly #supervisor = new PluginSupervisor();
  readonly #statuses = new Map<string, PluginRuntimeStatus>();
  readonly #directories = new Map<string, string>();
  readonly #starting = new Map<string, Promise<PluginRuntimeStatus>>();
  readonly #runtimeRoot: string;

  constructor(private readonly repository: PluginRepository, dataDir: string) {
    this.#runtimeRoot = resolve(dataDir, "plugin-runtime");
    mkdirSync(this.#runtimeRoot, { recursive: true });
    this.removeAbandonedDirectories();
  }

  async startAll(): Promise<void> {
    await Promise.all(this.repository.runtimePackageIds().map(async (id) => { await this.start(id); }));
  }

  start(id: string): Promise<PluginRuntimeStatus> {
    const pending = this.#starting.get(id);
    if (pending) return pending;
    const started = this.startOnce(id);
    this.#starting.set(id, started);
    void started.then(() => this.#starting.delete(id), () => this.#starting.delete(id));
    return started;
  }

  private async startOnce(id: string): Promise<PluginRuntimeStatus> {
    const running = this.#supervisor.get(id);
    if (running) return { id, status: "running", ...(running.pid ? { pid: running.pid } : {}) };
    await this.#supervisor.stop(id);
    this.removeDirectory(id);
    let directory: string | undefined;
    try {
      const plugin = this.repository.runtimePackage(id);
      const entrypoint = plugin.manifest.entrypoints[process.platform];
      if (!entrypoint) throw new Error("MISSING_PLATFORM_ENTRYPOINT");
      directory = mkdtempSync(join(this.#runtimeRoot, "run-"));
      writeFileSync(join(directory, ".statehub-runtime"), "statehub-plugin-runtime-v1", { mode: 0o600 });
      for (const [path, contents] of plugin.files) {
        const target = resolve(directory, path);
        if (!target.startsWith(`${directory}${sep}`)) throw new Error("UNSAFE_PLUGIN_PATH");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, { mode: 0o600 });
      }
      const target = resolve(directory, entrypoint);
      if (!target.startsWith(`${directory}${sep}`)) throw new Error("UNSAFE_PLUGIN_ENTRYPOINT");
      if (!/[.]([cm]?js)$/iu.test(extname(target))) chmodSync(target, 0o700);
      const isJavaScript = /\.[cm]?js$/iu.test(target);
      const { process: child, handshake } = await this.#supervisor.start(
        id, isJavaScript ? process.execPath : target, isJavaScript ? [target] : [], directory,
        (reasonCode) => this.#statuses.set(id, { id, status: "failed", reasonCode }),
      );
      const expectedSources = (plugin.manifest.sourceDefinitions ?? []).map((path) =>
        JSON.parse(Buffer.from(plugin.files.get(path) as Uint8Array).toString("utf8")) as unknown);
      const expectedDrivers = (plugin.manifest.driverDefinitions ?? []).map((path) =>
        JSON.parse(Buffer.from(plugin.files.get(path) as Uint8Array).toString("utf8")) as unknown);
      const hello = handshake as { protocolVersion?: unknown; sourceDefinitions?: unknown; driverDefinitions?: unknown } | null;
      if (!hello || hello.protocolVersion !== PLUGIN_PROTOCOL_VERSION ||
        stableStringify(hello.sourceDefinitions) !== stableStringify(expectedSources) ||
        stableStringify(hello.driverDefinitions) !== stableStringify(expectedDrivers)) {
        await this.#supervisor.stop(id);
        throw new Error("INCOMPATIBLE_HANDSHAKE");
      }
      const health = await child.health() as { status?: unknown } | null;
      if (!health || health.status !== "ok") {
        await this.#supervisor.stop(id);
        throw new Error("PLUGIN_HEALTH_FAILED");
      }
      this.#directories.set(id, directory);
      const status: PluginRuntimeStatus = { id, status: "running", ...(child.pid ? { pid: child.pid } : {}) };
      this.#statuses.set(id, status);
      return status;
    } catch (error) {
      await this.#supervisor.stop(id).catch(() => undefined);
      if (directory) this.removeExactDirectory(directory);
      const reason = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "PLUGIN_START_FAILED";
      const status: PluginRuntimeStatus = { id, status: "failed", reasonCode: reason };
      this.#statuses.set(id, status);
      return status;
    }
  }

  hasDriver(driverType: string): boolean {
    return this.repository.packageForDriver(driverType) !== undefined;
  }

  async execute(
    driverType: string,
    request: DriverActionRequest,
    instanceConfig: Record<string, unknown>,
  ): Promise<DriverActionResult> {
    const id = this.repository.packageForDriver(driverType);
    if (!id) return { status: "dead-letter", detail: "Plugin driver is not installed" };
    let process = this.#supervisor.get(id);
    if (!process) {
      const status = await this.start(id);
      if (status.status !== "running") return { status: "retry", detail: `Plugin ${status.reasonCode ?? "unavailable"}` };
      process = this.#supervisor.get(id);
    }
    if (!process) return { status: "retry", detail: "Plugin unavailable" };
    try {
      const response = await process.call("driver.execute", { ...request, instanceConfig });
      if (!response || typeof response !== "object") throw new Error("INVALID_DRIVER_RESULT");
      const result = response as Partial<DriverActionResult>;
      if (!result.status || !["delivered", "retry", "dead-letter", "suppressed"].includes(result.status)) {
        throw new Error("INVALID_DRIVER_RESULT");
      }
      return {
        status: result.status,
        ...(result.status === "retry" && typeof result.retryAfterMs === "number" &&
          Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0 && result.retryAfterMs <= 60_000
          ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.detail ? { detail: `Plugin ${result.status}` } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_DRIVER_RESULT") {
        await this.stop(id);
        this.#statuses.set(id, { id, status: "failed", reasonCode: "INVALID_DRIVER_RESULT" });
      }
      return { status: "retry", detail: "Plugin call failed" };
    }
  }

  statuses(): PluginRuntimeStatus[] {
    return this.repository.installed().map(({ id }) =>
      this.#statuses.get(id) ?? { id, status: "stopped" });
  }

  async stop(id: string): Promise<void> {
    await this.#starting.get(id)?.catch(() => undefined);
    await this.#supervisor.stop(id);
    this.removeDirectory(id);
    this.#statuses.set(id, { id, status: "stopped" });
  }

  async stopAll(): Promise<void> {
    await this.#supervisor.stopAll();
    for (const id of this.#directories.keys()) this.removeDirectory(id);
  }

  private removeDirectory(id: string): void {
    const directory = this.#directories.get(id);
    if (!directory) return;
    this.#directories.delete(id);
    this.removeExactDirectory(directory);
  }

  private removeAbandonedDirectories(): void {
    for (const entry of readdirSync(this.#runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("run-")) continue;
      const directory = join(this.#runtimeRoot, entry.name);
      try {
        if (readFileSync(join(directory, ".statehub-runtime"), "utf8") === "statehub-plugin-runtime-v1") {
          this.removeExactDirectory(directory);
        }
      } catch {
        // Only directories carrying our exact marker are eligible for cleanup.
      }
    }
  }

  private removeExactDirectory(directory: string): void {
    if (dirname(directory) !== this.#runtimeRoot) throw new Error("Refusing to remove an unexpected plugin runtime path");
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      process.stderr.write('{"type":"state-hub.plugin-runtime-cleanup-failed"}\n');
    }
  }
}

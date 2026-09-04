import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AcceptedCommand, CommandResult, OccurrenceEventInput, StateClaimInput } from "@state-hub/protocol";
import type { PublishedConfig, RuntimeSnapshot, SnapshotClaim } from "../service.js";

interface Discovery {
  schemaVersion: 1;
  host: "127.0.0.1";
  port: number;
  pid: number;
  instanceId: string;
  startedAt: string;
}

export interface AcceptanceEvent {
  id?: string;
  type: string;
  data: unknown;
}

interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

export class EventObserver {
  readonly #abort: AbortController;
  readonly #events: AcceptanceEvent[] = [];
  readonly #pump: Promise<void>;
  #failure: Error | undefined;
  #cursor = 0;

  constructor(response: Response, abort = new AbortController()) {
    if (!response.body) throw new Error("SSE response did not include a body");
    this.#abort = abort;
    this.#pump = this.consume(response.body);
  }

  async waitFor(
    type: string,
    predicate: (data: unknown) => boolean = () => true,
    options: WaitOptions = {},
  ): Promise<AcceptanceEvent> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (this.#failure) throw this.#failure;
      const index = this.#events.findIndex((event, eventIndex) =>
        eventIndex >= this.#cursor && event.type === type && predicate(event.data),
      );
      if (index >= 0) {
        const event = this.#events[index];
        if (!event) throw new Error("Matched SSE event disappeared");
        this.#cursor = index + 1;
        return event;
      }
      await delay(10);
    }
    throw new Error(`Timed out waiting for SSE event ${type}`);
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.#pump.catch(() => undefined);
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const abort = () => void reader.cancel().catch(() => undefined);
    this.#abort.signal.addEventListener("abort", abort, { once: true });
    try {
      while (!this.#abort.signal.aborted) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.acceptBlock(block);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!this.#abort.signal.aborted) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      this.#abort.signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }

  private acceptBlock(block: string): void {
    if (!block || block.startsWith(":")) return;
    let type = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trimStart();
      else if (line.startsWith("id:")) id = line.slice(3).trimStart();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    this.#events.push({ type, data: JSON.parse(data.join("\n")) as unknown, ...(id ? { id } : {}) });
  }
}

export class ProducerClient {
  constructor(
    private readonly harness: CoreAcceptanceHarness,
    readonly producerId: string,
    readonly token: string,
  ) {}

  async upsertClaim(
    scopeId: string,
    signalId: string,
    input: StateClaimInput,
    idempotencyKey?: string,
  ): Promise<{ response: Response; body: AcceptedCommand }> {
    const response = await this.fetch(
      `/api/v1/producers/${encodeURIComponent(this.producerId)}/scopes/${encodeURIComponent(scopeId)}/claims/${encodeURIComponent(signalId)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
        ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
      },
    );
    return { response, body: await responseJson<AcceptedCommand>(response.clone()) };
  }

  async clearClaim(
    scopeId: string,
    signalId: string,
    idempotencyKey?: string,
  ): Promise<{ response: Response; body: AcceptedCommand }> {
    const response = await this.fetch(
      `/api/v1/producers/${encodeURIComponent(this.producerId)}/scopes/${encodeURIComponent(scopeId)}/claims/${encodeURIComponent(signalId)}:clear`,
      {
        method: "POST",
        ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
      },
    );
    return { response, body: await responseJson<AcceptedCommand>(response.clone()) };
  }

  async emitEvent(
    input: OccurrenceEventInput,
    idempotencyKey?: string,
  ): Promise<{ response: Response; body: AcceptedCommand }> {
    const response = await this.fetch(`/api/v1/producers/${encodeURIComponent(this.producerId)}/events`, {
      method: "POST",
      body: JSON.stringify(input),
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    });
    return { response, body: await responseJson<AcceptedCommand>(response.clone()) };
  }

  async replaceSnapshot(
    claims: SnapshotClaim[],
    idempotencyKey?: string,
  ): Promise<{ response: Response; body: AcceptedCommand }> {
    const response = await this.fetch(`/api/v1/producers/${encodeURIComponent(this.producerId)}/snapshot`, {
      method: "PUT",
      body: JSON.stringify({ claims }),
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    });
    return { response, body: await responseJson<AcceptedCommand>(response.clone()) };
  }

  async command(commandId: string): Promise<CommandResult> {
    const response = await this.fetch(
      `/api/v1/producers/${encodeURIComponent(this.producerId)}/commands/${encodeURIComponent(commandId)}`,
    );
    return await responseJson<CommandResult>(response);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return await this.harness.fetch(path, { ...init, headers });
  }
}

export class AdminClient {
  constructor(private readonly harness: CoreAcceptanceHarness) {}

  async createProducer(producerId: string, sourceDefinitionId?: string): Promise<ProducerClient> {
    const response = await this.request("/api/v1/admin/producers", {
      method: "POST",
      body: JSON.stringify({ producerId, ...(sourceDefinitionId ? { sourceDefinitionId } : {}) }),
    });
    const body = await responseJson<{ producerId: string; token: string }>(response);
    return new ProducerClient(this.harness, body.producerId, body.token);
  }

  async publishConfig(config: PublishedConfig): Promise<number> {
    const draftResponse = await this.request("/api/v1/admin/config/drafts", {
      method: "POST",
      body: JSON.stringify(config),
    });
    const draft = await responseJson<{ revision: number }>(draftResponse);
    const publishResponse = await this.request(`/api/v1/admin/config/drafts/${draft.revision}/publish`, {
      method: "POST",
    });
    await responseJson<{ revision: number; status: string }>(publishResponse);
    return draft.revision;
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return await responseJson<RuntimeSnapshot>(await this.request("/api/v1/admin/snapshot"));
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.harness.adminToken}`);
    if (init.body) headers.set("content-type", "application/json");
    return await this.harness.fetch(path, { ...init, headers });
  }
}

export class CoreAcceptanceHarness {
  readonly adminToken = randomBytes(32).toString("base64url");
  readonly admin = new AdminClient(this);
  readonly paths: { root: string; data: string; runtime: string; database: string; discovery: string };
  #child: ChildProcess | undefined;
  #discovery: Discovery | undefined;
  #stdout = "";
  #stderr = "";
  readonly #observers = new Set<EventObserver>();

  private constructor(root: string) {
    const data = join(root, "data");
    const runtime = join(root, "runtime");
    this.paths = {
      root,
      data,
      runtime,
      database: join(data, "acceptance.db"),
      discovery: join(runtime, "discovery.json"),
    };
  }

  static async start(): Promise<CoreAcceptanceHarness> {
    const root = await mkdtemp(join(tmpdir(), "state-hub-core-acceptance-"));
    const harness = new CoreAcceptanceHarness(root);
    try {
      await harness.startProcess();
      return harness;
    } catch (error) {
      await harness.dispose();
      throw error;
    }
  }

  get discovery(): Discovery {
    if (!this.#discovery) throw new Error("Core is not running");
    return this.#discovery;
  }

  get processId(): number {
    const pid = this.#child?.pid;
    if (!pid || !this.isRunning) throw new Error("Core is not running");
    return pid;
  }

  get isRunning(): boolean {
    return Boolean(this.#child && this.#child.exitCode === null && this.#child.signalCode === null);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? AbortSignal.timeout(5_000);
    return await fetch(`http://${this.discovery.host}:${this.discovery.port}${path}`, { ...init, signal });
  }

  async observeEvents(): Promise<EventObserver> {
    const abort = new AbortController();
    const openTimer = setTimeout(() => abort.abort(), 5_000);
    try {
      const response = await this.fetch("/api/v1/admin/events", {
        headers: { authorization: `Bearer ${this.adminToken}` },
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`Could not open SSE stream: HTTP ${response.status}`);
      const observer = new EventObserver(response, abort);
      this.#observers.add(observer);
      return observer;
    } finally {
      clearTimeout(openTimer);
    }
  }

  async waitFor<T>(probe: () => T | false | undefined | Promise<T | false | undefined>, options: WaitOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const intervalMs = options.intervalMs ?? 20;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const result = await probe();
        if (result !== false && result !== undefined) return result;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
    throw new Error(`Timed out waiting for ${options.description ?? "acceptance condition"}.${detail}`);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child || !this.isRunning) {
      this.#child = undefined;
      this.#discovery = undefined;
      return;
    }
    await this.closeObservers();
    if (!child.connected || !child.send) throw new Error("Core process does not have its graceful-stop IPC channel");
    child.send({ type: "state-hub.stop" });
    try {
      await this.waitForExit(child, 5_000, "graceful Core stop");
    } catch (gracefulError) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await this.waitForExit(child, 5_000, "forced Core termination after graceful-stop timeout");
      } else {
        throw gracefulError;
      }
    }
    this.#child = undefined;
    this.#discovery = undefined;
  }

  async crash(): Promise<void> {
    const child = this.#child;
    if (!child || !this.isRunning) return;
    await this.closeObservers();
    child.kill("SIGKILL");
    await this.waitForExit(child, 5_000, "forced Core termination");
    this.#child = undefined;
    this.#discovery = undefined;
  }

  async restart(): Promise<void> {
    if (this.isRunning) await this.stop();
    await this.startProcess();
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    const record = (error: unknown): void => {
      failures.push(error);
    };
    const child = this.#child;

    if (this.isRunning) {
      try {
        await this.stop();
      } catch (error) {
        record(error);
      }
    } else {
      try {
        await this.closeObservers();
      } catch (error) {
        record(error);
      }
    }

    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          record(error);
        }
      }
      try {
        await this.waitForExit(child, 5_000, "dispose Core termination");
      } catch (error) {
        record(error);
      }
    }
    this.#child = undefined;
    this.#discovery = undefined;

    try {
      await this.closeObservers();
    } catch (error) {
      record(error);
    }

    try {
      const name = this.paths.root.split(/[\\/]/u).at(-1);
      if (!name?.startsWith("state-hub-core-acceptance-")) {
        throw new Error(`Refusing to remove unexpected acceptance path: ${this.paths.root}`);
      }
      await rm(this.paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      record(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Core acceptance harness cleanup failed");
    }
  }

  private async startProcess(): Promise<void> {
    if (this.isRunning) throw new Error("Core is already running");
    await unlink(this.paths.discovery).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.#stdout = "";
    this.#stderr = "";
    const coreRoot = resolve(import.meta.dirname, "../..");
    const entrypoint = resolve(import.meta.dirname, "../main.ts");
    const childEnvironment = { ...process.env };
    delete childEnvironment.STATE_HUB_BOOTSTRAP_PRODUCER_ID;
    delete childEnvironment.STATE_HUB_BOOTSTRAP_TOKEN;
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      cwd: coreRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...childEnvironment,
        STATE_HUB_ADMIN_TOKEN: this.adminToken,
        STATE_HUB_DATA_DIR: this.paths.data,
        STATE_HUB_RUNTIME_DIR: this.paths.runtime,
        STATE_HUB_DB_PATH: this.paths.database,
        STATE_HUB_PORT: "0",
      },
    });
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.#stdout = `${this.#stdout}${chunk}`.slice(-16_384);
    });
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
    });

    try {
      const discovery = await this.waitFor(async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Core exited during startup (${child.exitCode ?? child.signalCode})`);
        }
        const value = JSON.parse(await readFile(this.paths.discovery, "utf8")) as Discovery;
        return value.pid === child.pid ? value : false;
      }, { timeoutMs: 10_000, description: "Core discovery file" });
      this.#discovery = discovery;
      await this.waitFor(async () => {
        const response = await this.fetch("/health/live");
        return response.ok || false;
      }, { timeoutMs: 5_000, description: "Core health endpoint" });
    } catch (error) {
      if (this.isRunning) child.kill();
      await this.waitForExit(child, 5_000, "failed Core startup cleanup").catch(() => undefined);
      this.#child = undefined;
      this.#discovery = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}\nCore stdout:\n${this.#stdout}\nCore stderr:\n${this.#stderr}`);
    }
  }

  private async closeObservers(): Promise<void> {
    const observers = [...this.#observers];
    this.#observers.clear();
    await Promise.all(observers.map(async (observer) => await observer.close()));
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number, description: string): Promise<void> {
    const streamsClosed = [child.stdout, child.stderr].every((stream) => !stream || stream.destroyed);
    if ((child.exitCode !== null || child.signalCode !== null) && streamsClosed) return;
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${description}\nCore stdout:\n${this.#stdout}\nCore stderr:\n${this.#stderr}`));
      }, timeoutMs);
      const onClose = () => {
        cleanup();
        resolvePromise();
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("close", onClose);
      };
      child.once("close", onClose);
    });
  }
}

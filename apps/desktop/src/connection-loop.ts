import type { CoreConnection } from "./api.js";

export interface CoreTransport<Snapshot> {
  connection(): Promise<CoreConnection>;
  snapshot(connection: CoreConnection, signal: AbortSignal): Promise<Snapshot>;
  subscribe(connection: CoreConnection, onNotice: () => void, signal: AbortSignal): Promise<void>;
}

export interface ConnectionObserver<Snapshot> {
  snapshot(value: Snapshot | undefined): void;
  error(message: string | undefined): void;
}

export class CoreConnectionLoop<Snapshot> {
  #stop: AbortController | undefined;
  #cycle: AbortController | undefined;
  #task: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #immediate = false;
  #queueRefresh: (() => void) | undefined;

  constructor(
    private readonly transport: CoreTransport<Snapshot>,
    private readonly observer: ConnectionObserver<Snapshot>,
  ) {}

  start(): void {
    if (this.#stop) return;
    this.#stop = new AbortController();
    this.#task = this.run(this.#stop.signal);
  }

  async stop(): Promise<void> {
    this.#stop?.abort();
    this.#cycle?.abort();
    this.#wake?.();
    await this.#task;
    this.#task = undefined;
    this.#stop = undefined;
  }

  reconnectNow(): void {
    this.#immediate = true;
    this.#cycle?.abort();
    this.#wake?.();
  }

  requestRefresh(): void {
    this.#queueRefresh?.();
  }

  private async run(stop: AbortSignal): Promise<void> {
    let failures = 0;
    while (!stop.aborted) {
      const cycle = new AbortController();
      this.#cycle = cycle;
      const abortCycle = () => cycle.abort();
      stop.addEventListener("abort", abortCycle, { once: true });
      let connectedAt = 0;
      try {
        const connection = await this.transport.connection();
        if (cycle.signal.aborted) continue;
        const baseline = await this.transport.snapshot(connection, cycle.signal);
        if (cycle.signal.aborted) continue;
        const current = await this.transport.connection();
        if (cycle.signal.aborted || current.generation !== connection.generation) continue;
        this.observer.snapshot(baseline);
        this.observer.error(undefined);
        connectedAt = Date.now();

        let pending = false;
        let loading = false;
        this.#queueRefresh = () => {
          if (cycle.signal.aborted) return;
          pending = true;
          if (loading) return;
          loading = true;
          void (async () => {
            while (pending && !cycle.signal.aborted) {
              pending = false;
              try {
                const latest = await this.transport.snapshot(connection, cycle.signal);
                if (!cycle.signal.aborted) this.observer.snapshot(latest);
              } catch {
                cycle.abort();
              }
            }
            loading = false;
          })();
        };
        await this.transport.subscribe(connection, this.#queueRefresh, cycle.signal);
        if (!cycle.signal.aborted) throw new Error("SSE_ENDED");
      } catch {
        // Only the safe connection category is shown. Network and sidecar error bodies are untrusted.
      } finally {
        cycle.abort();
        stop.removeEventListener("abort", abortCycle);
        this.#cycle = undefined;
        this.#queueRefresh = undefined;
        if (!stop.aborted) {
          this.observer.snapshot(undefined);
          this.observer.error("Core connection unavailable");
        }
      }
      if (stop.aborted) break;
      if (connectedAt && Date.now() - connectedAt >= 10_000) failures = 0;
      failures += 1;
      const delay = Math.min(250 * 2 ** Math.min(failures - 1, 4), 4_000);
      if (this.#immediate) this.#immediate = false;
      else await this.wait(delay, stop);
    }
  }

  private async wait(delay: number, stop: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        stop.removeEventListener("abort", done);
        if (this.#wake === done) this.#wake = undefined;
        resolve();
      };
      timer = setTimeout(done, delay);
      this.#wake = done;
      stop.addEventListener("abort", done, { once: true });
    });
  }
}

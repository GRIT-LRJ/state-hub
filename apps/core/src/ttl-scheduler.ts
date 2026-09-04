import type { HubEventBus } from "./events.js";
import type { StateHubService } from "./service.js";

const maximumTimerDelayMs = 2_147_483_647;

export interface TtlSchedulerClock {
  now(): Date;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: TtlSchedulerClock = {
  now: () => new Date(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

export class ClaimTtlScheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  #running = false;
  #processing = false;

  constructor(
    private readonly service: StateHubService,
    private readonly events: HubEventBus,
    private readonly clock: TtlSchedulerClock = systemClock,
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe = this.events.subscribe((event) => {
      if (event.type === "snapshot.changed" && !this.#processing) this.refresh();
    });
    this.processAndSchedule();
  }

  stop(): void {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#timer) this.clock.clearTimer(this.#timer);
    this.#timer = undefined;
  }

  refresh(): void {
    if (!this.#running) return;
    if (this.#timer) this.clock.clearTimer(this.#timer);
    this.#timer = undefined;
    this.scheduleNext();
  }

  private processAndSchedule(): void {
    if (!this.#running) return;
    this.#timer = undefined;
    this.#processing = true;
    try {
      this.service.processDueClaimExpirations(this.clock.now());
    } finally {
      this.#processing = false;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.#running) return;
    const now = this.clock.now().getTime();
    const deadline = this.service
      .listPendingClaimExpirations()
      .map((expiration) => Date.parse(expiration.expiresAt))
      .filter((timestamp) => Number.isFinite(timestamp))
      .reduce<number | undefined>(
        (earliest, timestamp) => earliest === undefined || timestamp < earliest ? timestamp : earliest,
        undefined,
      );
    if (deadline === undefined) return;
    const delay = Math.min(Math.max(0, deadline - now), maximumTimerDelayMs);
    this.#timer = this.clock.setTimer(() => this.processAndSchedule(), delay);
    this.#timer.unref?.();
  }
}

import { EventEmitter } from "node:events";

export interface HubEvent {
  id: number;
  type: string;
  data: unknown;
  at: string;
}

export class HubEventBus {
  readonly #emitter = new EventEmitter();
  #sequence = 0;

  publish(type: string, data: unknown): HubEvent {
    const event = { id: ++this.#sequence, type, data, at: new Date().toISOString() };
    this.#emitter.emit("event", event);
    this.#emitter.emit("notice", type);
    return event;
  }

  publishLazy(type: string, data: () => unknown): void {
    if (this.#emitter.listenerCount("event") > 0) this.publish(type, data());
    else {
      this.#sequence += 1;
      this.#emitter.emit("notice", type);
    }
  }

  subscribeNotice(listener: (type: string) => void): () => void {
    this.#emitter.on("notice", listener);
    return () => this.#emitter.off("notice", listener);
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}

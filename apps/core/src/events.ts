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
    return event;
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}

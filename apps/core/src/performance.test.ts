import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerProducer } from "./auth.js";
import { StateHubDatabase } from "./database.js";
import { HubEventBus } from "./events.js";
import { StateHubService } from "./service.js";

let db: StateHubDatabase;
let service: StateHubService;
const producerToken = "load-test-token-with-high-entropy";

beforeAll(() => {
  db = new StateHubDatabase(":memory:");
  service = new StateHubService(db, new HubEventBus());
  registerProducer(db, "load", producerToken);
});

afterAll(() => db.close());

it("accepts a 1000-event burst with command commit P95 below 100ms", () => {
  const durations: number[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    service.emitEvent("load", producerToken, {
      eventId: `burst-${index}`,
      type: "load.sample",
      scopeId: `scope-${index % 50}`,
      value: { index },
    });
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  expect(p95).toBeLessThanOrEqual(100);
});

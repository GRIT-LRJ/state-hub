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

it("commits every command and event in a 1000-event burst", () => {
  const commands = new Set<string>();
  for (let index = 0; index < 1_000; index += 1) {
    const accepted = service.emitEvent("load", producerToken, {
      eventId: `burst-${index}`,
      type: "load.sample",
      scopeId: `scope-${index % 50}`,
      value: { index },
    });
    commands.add(accepted.commandId);
    expect(service.getCommand("load", accepted.commandId)?.status).toBe("applied");
  }
  expect(commands.size).toBe(1000);
  expect(db.raw.prepare("SELECT count(*) AS count FROM occurrence_events").get()).toEqual({ count: 1000 });
});

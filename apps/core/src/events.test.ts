import { expect, it, vi } from "vitest";
import { HubEventBus } from "./events.js";

it("keeps internal notices active without constructing unobserved snapshot payloads", () => {
  const events = new HubEventBus();
  const notice = vi.fn();
  const makeSnapshot = vi.fn(() => ({ revision: 7 }));
  const stopNotice = events.subscribeNotice(notice);
  events.publishLazy("snapshot.changed", makeSnapshot);
  expect(notice).toHaveBeenCalledWith("snapshot.changed");
  expect(makeSnapshot).not.toHaveBeenCalled();

  const snapshots: unknown[] = [];
  const stopSnapshots = events.subscribe((event) => snapshots.push(event));
  events.publishLazy("snapshot.changed", makeSnapshot);
  expect(makeSnapshot).toHaveBeenCalledTimes(1);
  expect(snapshots).toEqual([expect.objectContaining({ id: 2, type: "snapshot.changed", data: { revision: 7 } })]);
  stopSnapshots();
  events.publishLazy("snapshot.changed", makeSnapshot);
  expect(makeSnapshot).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenCalledTimes(3);
  stopNotice();
});

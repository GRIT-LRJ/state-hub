import { describe, expect, it } from "vitest";
import { isFetchAllowedPort, listenFetchCompatible } from "./fetch-safe-listener.js";

describe("Core loopback listener for Fetch clients", () => {
  it("rejects the blocked ports observed in the Windows ephemeral range", () => {
    expect(isFetchAllowedPort(6666)).toBe(false);
    expect(isFetchAllowedPort(10080)).toBe(false);
    expect(isFetchAllowedPort(0)).toBe(false);
    expect(isFetchAllowedPort(15001)).toBe(true);
  });

  it("closes a blocked listener and retries before publishing its address", async () => {
    const assigned = [6666, 10080, 15001];
    const closed: number[] = [];
    let created = 0;
    const result = await listenFetchCompatible(() => {
      const index = created++;
      return {
        listen: async ({ port }: { host: string; port: number }) => {
          expect(port).toBe(0);
          return `http://127.0.0.1:${assigned[index]}`;
        },
        close: async () => { closed.push(index); },
      };
    }, "127.0.0.1", 0);
    expect(result.port).toBe(15001);
    expect(created).toBe(3);
    expect(closed).toEqual([0, 1]);
  });

  it("fails after a bounded number of blocked allocations", async () => {
    let closed = 0;
    await expect(listenFetchCompatible(() => ({
      listen: async () => "http://127.0.0.1:6666",
      close: async () => { closed += 1; },
    }), "127.0.0.1", 0, 2)).rejects.toThrow("Fetch-compatible Core port");
    expect(closed).toBe(2);
  });

  it("rejects an explicitly configured blocked port before opening a listener", async () => {
    let created = 0;
    await expect(listenFetchCompatible(() => {
      created += 1;
      return { listen: async () => "http://127.0.0.1:6666", close: async () => undefined };
    }, "127.0.0.1", 6666)).rejects.toThrow("Core HTTP port is unavailable");
    expect(created).toBe(0);
  });
});

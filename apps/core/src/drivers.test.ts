import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GenericHttpDriver, Vk87Driver } from "./drivers.js";

describe("driver guardrails", () => {
  it("blocks loopback targets unless private-network access is explicit", async () => {
    const driver = new GenericHttpDriver({ baseUrl: "http://127.0.0.1:1/hook" });
    const result = await driver.execute({
      deliveryId: "d1",
      driverInstanceId: "http",
      resourceChannel: "default",
      actionKind: "queued-effect",
      action: { name: "send", params: {} },
    });
    expect(result.status).toBe("retry");
    expect(result.detail).toMatch(/blocked private/u);
  });

  it("accepts only the verified VK87 selector and complete reports", () => {
    const profile = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../assets/vk87-profile.example.json"), "utf8"),
    ) as unknown;
    expect(() => new Vk87Driver(profile)).not.toThrow();
    expect(() => new Vk87Driver({ ...(profile as object), usage: 1 })).toThrow(/verified device selector/u);
  });
});

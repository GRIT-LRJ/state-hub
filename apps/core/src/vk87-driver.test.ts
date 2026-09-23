import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriverActionRequest } from "@state-hub/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vk87Driver } from "./drivers.js";

const fake = vi.hoisted(() => ({
  devices: [] as Array<{ path?: string; vendorId: number; productId: number; usagePage: number; usage: number }>,
  opens: [] as string[],
  writes: [] as number[][],
  closes: 0,
  failEnumeration: false,
  failOpen: false,
  failWrite: false,
  failClose: false,
}));

vi.mock("node-hid", () => ({
  HID: class {
    static devices() {
      if (fake.failEnumeration) throw new Error("Authorization: Bearer secret-enumeration");
      return fake.devices;
    }
    constructor(path: string) {
      fake.opens.push(path);
      if (fake.failOpen) throw new Error("Authorization: Bearer secret-open");
    }
    sendFeatureReport(data: number[]) {
      fake.writes.push(data);
      if (fake.failWrite) throw new Error("Authorization: Bearer secret-write");
      return data.length;
    }
    close() {
      fake.closes += 1;
      if (fake.failClose) throw new Error("Authorization: Bearer secret-close");
    }
  },
}));

const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, "../assets/vk87-profile.example.json"), "utf8")) as
  Record<string, unknown> & { completedReportHex: string; decisionReportHex: string; restoreReportHex: string };
const correct = { path: "verified-interface", vendorId: 0x374a, productId: 0xa270,
  usagePage: 0xffff, usage: 0x0002 };

function request(action: "completed" | "decision" | "idle" | "unknown" | null): DriverActionRequest {
  return { deliveryId: "delivery", driverInstanceId: "vk87-main", resourceChannel: "light",
    actionKind: "stateful", action: action ? { name: action, params: {} } : null,
    projectionRevision: 1 };
}

beforeEach(() => {
  fake.devices = [{ ...correct }];
  fake.opens = [];
  fake.writes = [];
  fake.closes = 0;
  fake.failEnumeration = false;
  fake.failOpen = false;
  fake.failWrite = false;
  fake.failClose = false;
});

describe("VK87 fake HID safety contract", () => {
  it("selects only one exact interface, ignoring every wrong selector and absent path", async () => {
    fake.devices = [
      { ...correct, vendorId: 1 }, { ...correct, productId: 1 },
      { ...correct, usagePage: 1 }, { ...correct, usage: 1 },
      { vendorId: correct.vendorId, productId: correct.productId,
        usagePage: correct.usagePage, usage: correct.usage }, { ...correct },
    ];
    expect((await new Vk87Driver(profile).execute(request("decision"))).status).toBe("delivered");
    expect(fake.opens).toEqual(["verified-interface"]);
    expect(fake.writes).toEqual([[...Buffer.from(profile.decisionReportHex, "hex")]]);
    expect(fake.writes[0]).toHaveLength(65);
    expect(fake.closes).toBe(1);
  });

  it("rejects missing and ambiguous interfaces before opening or writing", async () => {
    for (const devices of [[], [{ ...correct, usage: 1 }], [{ ...correct }, { ...correct, path: "second" }]]) {
      fake.devices = devices;
      expect((await new Vk87Driver(profile).execute(request("completed"))).status).toBe("retry");
      expect(fake.opens).toEqual([]);
      expect(fake.writes).toEqual([]);
    }
  });

  it("rejects every profile selector or report-length deviation before HID is loaded", () => {
    for (const [key, value] of [
      ["enabled", false], ["vendorId", 1], ["productId", 1], ["usagePage", 1],
      ["usage", 1], ["featureReportLength", 64], ["reportId", 1],
      ["completedReportHex", profile.completedReportHex.slice(0, -2)],
      ["decisionReportHex", `01${profile.decisionReportHex.slice(2)}`],
      ["restoreReportHex", `${profile.restoreReportHex}00`],
    ] as const) {
      expect(() => new Vk87Driver({ ...profile, [key]: value })).toThrow();
    }
    expect(() => new Vk87Driver(null)).toThrow();
    expect(fake.opens).toEqual([]);
    expect(fake.writes).toEqual([]);
  });

  it("sends each complete verified report and restores safely on idle", async () => {
    const driver = new Vk87Driver(profile);
    for (const [action, report] of [
      ["completed", profile.completedReportHex], ["decision", profile.decisionReportHex],
      ["idle", profile.restoreReportHex], [null, profile.restoreReportHex],
    ] as const) {
      expect((await driver.execute(request(action))).status).toBe("delivered");
      expect(fake.writes.at(-1)).toEqual([...Buffer.from(report, "hex")]);
      expect(fake.writes.at(-1)).toHaveLength(65);
    }
    expect(fake.opens).toHaveLength(4);
    expect(fake.closes).toBe(4);
    expect((await driver.execute(request("unknown"))).status).toBe("dead-letter");
    expect(fake.opens).toHaveLength(4);
  });

  it("fails safely on open and native write errors without exposing their text", async () => {
    const driver = new Vk87Driver(profile);
    fake.failEnumeration = true;
    expect(await driver.execute(request("decision"))).toMatchObject({ status: "retry", detail: "VK87_ENUMERATION_FAILED" });
    fake.failEnumeration = false;
    fake.failOpen = true;
    expect(await driver.execute(request("decision"))).toMatchObject({ status: "retry", detail: "VK87_OPEN_FAILED" });
    expect(fake.writes).toEqual([]);
    fake.failOpen = false;
    fake.failWrite = true;
    expect(await driver.execute(request("decision"))).toMatchObject({ status: "retry", detail: "VK87_WRITE_FAILED" });
    fake.failWrite = false;
    fake.failClose = true;
    expect((await driver.execute(request("decision"))).status).toBe("delivered");
  });
});

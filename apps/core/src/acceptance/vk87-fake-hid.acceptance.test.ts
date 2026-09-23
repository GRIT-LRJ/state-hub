import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../assets/vk87-profile.example.json"), "utf8")) as
  { decisionReportHex: string; restoreReportHex: string };
const preload = resolve(import.meta.dirname, "../../tests/fake-hid-preload.mjs");

describe("VK87 driver contract through a real Core and fake HID", () => {
  it("publishes a verified profile, writes the complete decision report, then writes safe idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "state-hub-fake-hid-"));
    const fixture = join(root, "fixture.json");
    const log = join(root, "writes.jsonl");
    writeFileSync(fixture, JSON.stringify({ log, writeLength: 66, devices: [{ path: "fake-verified-interface",
      vendorId: 0x374a, productId: 0xa270, usagePage: 0xffff, usage: 0x0002 }] }));
    let harness: CoreAcceptanceHarness | undefined;
    const writes = (): Array<{ path: string; data: number[] }> => existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { path: string; data: number[] })
      : [];
    try {
      harness = await CoreAcceptanceHarness.start({ childEnvironment: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
        STATE_HUB_FAKE_HID_FIXTURE: fixture,
      } });
      const producer = await harness.admin.createProducer("codex", "official.codex");
      const binding: Binding = {
        id: "vk87-decision", name: "VK87 decision", enabled: true,
        selector: { producerId: "codex", scopePattern: "*", signalId: "status" },
        conditions: [], mapping: {},
        target: { driverInstanceId: "vk87-main", resourceChannel: "keyboard-light",
          actionKind: "stateful", actionName: "decision" },
      };
      await harness.admin.publishConfig({ bindings: [binding], driverInstances: [{
        id: "vk87-main", driverType: "vk87", enabled: true, config: { profile },
      }] });
      expect((await producer.upsertClaim("session-a", "status", {
        value: { phase: "decision" }, urgency: "action-required",
      })).response.status).toBe(202);
      await harness.waitFor(() => writes().length === 1, { description: "one fake HID decision write" });
      expect(writes()).toEqual([{ path: "fake-verified-interface",
        data: [...Buffer.from(profile.decisionReportHex, "hex")] }]);
      expect(writes()[0]?.data).toHaveLength(65);

      expect((await producer.clearClaim("session-a", "status")).response.status).toBe(202);
      await harness.waitFor(() => writes().length === 2, { description: "one fake HID idle write" });
      expect(writes()[1]).toEqual({ path: "fake-verified-interface",
        data: [...Buffer.from(profile.restoreReportHex, "hex")] });
      expect(writes()[1]?.data).toHaveLength(65);
      await harness.waitFor(async () => (await harness!.admin.snapshot()).pendingDeliveries === 0 || false);
      expect(writes()).toHaveLength(2);
    } finally {
      await harness?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

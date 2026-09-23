import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = resolve(import.meta.dirname, "../scripts/vk87-manual-smoke.mjs");

describe("VK87 manual hardware entry", () => {
  it("does not load HID without all three opt-in conditions", () => {
    for (const [args, allowed] of [
      [[], "1"], [["--write-real-vk87"], "0"], [["--write-real-vk87"], "1"],
    ] as const) {
      const result = spawnSync(process.execPath, [entry, ...args], {
        env: { ...process.env, STATE_HUB_ALLOW_REAL_VK87: allowed },
        encoding: "utf8", timeout: 2_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("hardware write is disabled");
      expect(result.stderr).toBe("");
    }
  });
});

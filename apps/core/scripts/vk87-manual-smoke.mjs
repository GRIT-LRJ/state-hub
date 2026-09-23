import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const optedIn = process.argv.includes("--write-real-vk87") &&
  process.env.STATE_HUB_ALLOW_REAL_VK87 === "1" && process.stdin.isTTY === true;
if (!optedIn) {
  process.stdout.write("VK87 hardware write is disabled. See docs/OPERATIONS.md for the manual opt-in steps.\n");
  process.exit(0);
}

const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, "../assets/vk87-profile.example.json"), "utf8"));
const { Vk87Driver } = await import("../dist/drivers.js");
const driver = new Vk87Driver(profile);
const action = (name) => ({ deliveryId: `manual-${name}`, driverInstanceId: "manual-vk87",
  resourceChannel: "keyboard-light", actionKind: "stateful",
  action: { name, params: {} }, projectionRevision: 1 });

let decision;
try {
  decision = await driver.execute(action("decision"));
} finally {
  const idle = await driver.execute(action("idle"));
  process.stdout.write(`VK87 idle restore: ${idle.status}\n`);
  if (idle.status !== "delivered") process.exitCode = 1;
}
process.stdout.write(`VK87 decision report: ${decision.status}\n`);
if (decision.status !== "delivered") process.exitCode = 1;

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registerProducer } from "./auth.js";
import { loadConfig } from "./config.js";
import { StateHubDatabase } from "./database.js";
import { DeliveryDispatcher } from "./dispatcher.js";
import { DriverRegistry } from "./drivers.js";
import { HubEventBus } from "./events.js";
import { createServer } from "./server.js";
import { StateHubService } from "./service.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.runtimeDir, { recursive: true });
mkdirSync(config.spoolDir, { recursive: true });

const db = new StateHubDatabase(config.databasePath);
const events = new HubEventBus();
const service = new StateHubService(db, events);

if (config.bootstrapProducerId && config.bootstrapProducerToken) {
  registerProducer(db, config.bootstrapProducerId, config.bootstrapProducerToken);
}
const instanceCount = db.raw.prepare("SELECT count(*) AS count FROM driver_instances").get() as { count: number };
if (instanceCount.count === 0) {
  db.raw
    .prepare(
      "INSERT INTO driver_instances(id, driver_type, config_json, enabled, physical_resource_key) VALUES ('virtual-main', 'virtual', '{}', 1, NULL)",
    )
    .run();
}

const drivers = new DriverRegistry(db, events);
const dispatcher = new DeliveryDispatcher(db, drivers, events);
const app = createServer({ service, events, drivers, adminToken: config.adminToken });
const address = await app.listen({ host: config.host, port: config.port });
const port = Number.parseInt(new URL(address).port, 10);
const discovery = {
  schemaVersion: 1,
  host: config.host,
  port,
  pid: process.pid,
  instanceId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
};
const temporaryDiscovery = `${config.discoveryPath}.${process.pid}.tmp`;
mkdirSync(dirname(config.discoveryPath), { recursive: true });
writeFileSync(temporaryDiscovery, `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(temporaryDiscovery, config.discoveryPath);
try {
  chmodSync(config.discoveryPath, 0o600);
} catch {
  // Windows ACL inheritance provides the current-user boundary; POSIX uses chmod above.
}

dispatcher.start();
const cleanupTimer = setInterval(() => service.cleanupHistory(), 60 * 60 * 1000);
cleanupTimer.unref();
process.stdout.write(`${JSON.stringify({ type: "state-hub.ready", ...discovery })}\n`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanupTimer);
  dispatcher.stop();
  drivers.invalidate();
  await app.close();
  db.close();
  try {
    unlinkSync(config.discoveryPath);
  } catch {
    // Another supervisor instance may already have replaced it.
  }
};

process.on("SIGINT", () => void stop().finally(() => process.exit(0)));
process.on("SIGTERM", () => void stop().finally(() => process.exit(0)));

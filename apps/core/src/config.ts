import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export interface CoreConfig {
  dataDir: string;
  runtimeDir: string;
  databasePath: string;
  discoveryPath: string;
  spoolDir: string;
  host: "127.0.0.1";
  port: number;
  deliveryLeaseMs: number;
  adminToken: string;
  bootstrapProducerId?: string;
  bootstrapProducerToken?: string;
}

function defaultDataDir(): string {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "StateHub");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "StateHub");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "state-hub");
}

function defaultRuntimeDir(): string {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? tmpdir(), "StateHub", "runtime");
  return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `state-hub-${process.getuid?.() ?? "user"}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const dataDir = env.STATE_HUB_DATA_DIR ?? defaultDataDir();
  const runtimeDir = env.STATE_HUB_RUNTIME_DIR ?? defaultRuntimeDir();
  const adminToken = env.STATE_HUB_ADMIN_TOKEN;
  if (!adminToken || adminToken.length < 32) {
    throw new Error("STATE_HUB_ADMIN_TOKEN must be provided by the Tauri supervisor and contain at least 32 characters");
  }
  const deliveryLeaseMs = Number.parseInt(env.STATE_HUB_DELIVERY_LEASE_MS ?? "30000", 10);
  if (!Number.isSafeInteger(deliveryLeaseMs) || deliveryLeaseMs <= 0) {
    throw new Error("STATE_HUB_DELIVERY_LEASE_MS must be a positive integer");
  }
  return {
    dataDir,
    runtimeDir,
    databasePath: env.STATE_HUB_DB_PATH ?? join(dataDir, "state-hub.db"),
    discoveryPath: join(runtimeDir, "discovery.json"),
    spoolDir: join(dataDir, "spool"),
    host: "127.0.0.1",
    port: Number.parseInt(env.STATE_HUB_PORT ?? "0", 10),
    deliveryLeaseMs,
    adminToken,
    ...(env.STATE_HUB_BOOTSTRAP_PRODUCER_ID
      ? { bootstrapProducerId: env.STATE_HUB_BOOTSTRAP_PRODUCER_ID }
      : {}),
    ...(env.STATE_HUB_BOOTSTRAP_TOKEN ? { bootstrapProducerToken: env.STATE_HUB_BOOTSTRAP_TOKEN } : {}),
  };
}

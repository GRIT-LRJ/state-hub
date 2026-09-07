import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { AsyncEntry } from "@napi-rs/keyring";
import type { ActionPayload, DriverActionRequest, DriverActionResult } from "@state-hub/protocol";
import type { StateHubDatabase } from "./database.js";
import type { HubEventBus } from "./events.js";

export interface Driver {
  execute(request: DriverActionRequest): Promise<DriverActionResult>;
  close?(): Promise<void> | void;
}

export interface SecretProvider {
  get(reference: string): Promise<string | undefined>;
}

export class UnavailableSecretProvider implements SecretProvider {
  async get(_reference: string): Promise<undefined> {
    return undefined;
  }
}

export class OsSecretProvider implements SecretProvider {
  async get(reference: string): Promise<string | undefined> {
    try {
      return await new AsyncEntry("dev.statehub.desktop", reference).getPassword(AbortSignal.timeout(2_000));
    } catch {
      return undefined;
    }
  }
}

export class VirtualDriver implements Driver {
  readonly state = new Map<string, ActionPayload>();
  readonly #projectionRevisions = new Map<string, number>();

  constructor(
    private readonly instanceId: string,
    private readonly events: HubEventBus,
  ) {}

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    if (request.actionKind === "stateful") {
      if (request.projectionRevision === undefined) {
        return { status: "dead-letter", detail: "Stateful action requires a projection revision" };
      }
      const currentRevision = this.#projectionRevisions.get(request.resourceChannel);
      if (currentRevision !== undefined && request.projectionRevision < currentRevision) {
        return { status: "suppressed", detail: "Virtual output already applied a newer projection revision" };
      }
      this.#projectionRevisions.set(request.resourceChannel, request.projectionRevision);
    }
    if (request.action) this.state.set(request.resourceChannel, request.action);
    else this.state.delete(request.resourceChannel);
    this.events.publish("virtual.rendered", {
      driverInstanceId: this.instanceId,
      resourceChannel: request.resourceChannel,
      action: request.action,
      ...(request.projectionRevision === undefined ? {} : { projectionRevision: request.projectionRevision }),
    });
    return { status: "delivered" };
  }
}

interface HttpDriverConfig {
  baseUrl: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

async function pinnedJsonRequest(
  config: HttpDriverConfig,
  payload: unknown,
): Promise<{ statusCode: number; body: string }> {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) targets are allowed");
  if (url.username || url.password) throw new Error("Credentials in target URLs are forbidden");
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error("Target hostname did not resolve");
  if (!config.allowPrivateNetwork && resolved.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("Target resolves to a blocked private, local, or special-use address");
  }
  const selected = resolved[0];
  if (!selected) throw new Error("Target hostname did not resolve");
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  for (const name of Object.keys(config.headers ?? {})) {
    if (/^(authorization|cookie|proxy-authorization|x-api-key)$/iu.test(name)) {
      throw new Error(`Sensitive header ${name} must use a credential reference, not inline configuration`);
    }
  }
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: selected.address,
        family: selected.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: config.method ?? "POST",
        servername: url.hostname,
        headers: {
          host: url.host,
          "content-type": "application/json",
          "content-length": String(data.length),
          ...config.headers,
        },
        timeout: Math.min(Math.max(config.timeoutMs ?? 5_000, 100), 30_000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const max = Math.min(config.maxResponseBytes ?? 65_536, 1_048_576);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            response.destroy(new Error("HTTP driver response exceeded configured limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("HTTP driver request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

export class GenericHttpDriver implements Driver {
  constructor(private readonly config: HttpDriverConfig) {}

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    try {
      const response = await pinnedJsonRequest(this.config, {
        deliveryId: request.deliveryId,
        channel: request.resourceChannel,
        actionKind: request.actionKind,
        action: request.action,
        ...(request.projectionRevision === undefined ? {} : { projectionRevision: request.projectionRevision }),
      });
      if (response.statusCode >= 200 && response.statusCode < 300) return { status: "delivered" };
      if (response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500) {
        return { status: "retry", detail: `HTTP ${response.statusCode}` };
      }
      return { status: "dead-letter", detail: `HTTP ${response.statusCode}: ${response.body.slice(0, 200)}` };
    } catch (error) {
      return { status: "retry", detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface PushPlusConfig {
  tokenSecretRef: string;
  topic?: string;
  endpoint?: string;
}

export class PushPlusDriver implements Driver {
  constructor(
    private readonly config: PushPlusConfig,
    private readonly secrets: SecretProvider,
  ) {}

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    const token = await this.secrets.get(this.config.tokenSecretRef);
    if (!token) return { status: "dead-letter", detail: "OS credential is unavailable; plaintext fallback is forbidden" };
    const params = request.action?.params ?? {};
    try {
      const response = await pinnedJsonRequest(
        {
          baseUrl: this.config.endpoint ?? "https://www.pushplus.plus/send",
          method: "POST",
          timeoutMs: 10_000,
        },
        {
          token,
          title: String(params.title ?? "State Hub"),
          content: String(params.content ?? ""),
          ...(this.config.topic ? { topic: this.config.topic } : {}),
        },
      );
      if (response.statusCode >= 200 && response.statusCode < 300) return { status: "delivered" };
      return response.statusCode === 429 || response.statusCode >= 500
        ? { status: "retry", detail: `PushPlus HTTP ${response.statusCode}` }
        : { status: "dead-letter", detail: `PushPlus HTTP ${response.statusCode}` };
    } catch (error) {
      return { status: "retry", detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface Vk87Profile {
  enabled: boolean;
  vendorId: 14154;
  productId: 41584;
  usagePage: 65535;
  usage: 2;
  featureReportLength: 65;
  reportId: 0;
  completedReportHex: string;
  decisionReportHex: string;
  restoreReportHex: string;
}

function verifyVk87Profile(value: unknown): Vk87Profile {
  const profile = value as Partial<Vk87Profile>;
  if (
    profile.enabled !== true ||
    profile.vendorId !== 0x374a ||
    profile.productId !== 0xa270 ||
    profile.usagePage !== 0xffff ||
    profile.usage !== 0x0002 ||
    profile.featureReportLength !== 65 ||
    profile.reportId !== 0
  ) {
    throw new Error("VK87 profile does not match the verified device selector");
  }
  for (const report of [profile.completedReportHex, profile.decisionReportHex, profile.restoreReportHex]) {
    if (!report || !/^[0-9a-f]{130}$/iu.test(report) || !report.startsWith("00")) {
      throw new Error("VK87 profile must contain complete 65-byte feature reports with report id 0");
    }
  }
  return profile as Vk87Profile;
}

export class Vk87Driver implements Driver {
  readonly #profile: Vk87Profile;

  constructor(profile: unknown) {
    this.#profile = verifyVk87Profile(profile);
  }

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    let module: typeof import("node-hid");
    try {
      module = await import("node-hid");
    } catch {
      return { status: "retry", detail: "node-hid is not available on this platform" };
    }
    const candidates = module.HID.devices().filter(
      (device) =>
        device.vendorId === this.#profile.vendorId &&
        device.productId === this.#profile.productId &&
        device.usagePage === this.#profile.usagePage &&
        device.usage === this.#profile.usage &&
        device.path,
    );
    if (candidates.length !== 1 || !candidates[0]?.path) {
      return { status: "retry", detail: `Expected exactly one writable VK87 interface, found ${candidates.length}` };
    }
    const action = request.action?.name ?? "idle";
    const reportHex =
      action === "completed"
        ? this.#profile.completedReportHex
        : action === "decision"
          ? this.#profile.decisionReportHex
          : this.#profile.restoreReportHex;
    const device = new module.HID(candidates[0].path);
    try {
      device.sendFeatureReport([...Buffer.from(reportHex, "hex")]);
      return { status: "delivered" };
    } catch (error) {
      return { status: "retry", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      device.close();
    }
  }
}

interface InstanceRow {
  id: string;
  driver_type: string;
  config_json: string;
  enabled: number;
}

export class DriverRegistry {
  readonly #cache = new Map<string, Driver>();

  constructor(
    private readonly db: StateHubDatabase,
    private readonly events: HubEventBus,
    private readonly secrets: SecretProvider = new OsSecretProvider(),
  ) {}

  get(instanceId: string): Driver | undefined {
    const cached = this.#cache.get(instanceId);
    if (cached) return cached;
    const row = this.db.raw.prepare("SELECT * FROM driver_instances WHERE id = ?").get(instanceId) as
      | InstanceRow
      | undefined;
    if (!row || row.enabled !== 1) return undefined;
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    let driver: Driver;
    if (row.driver_type === "virtual") driver = new VirtualDriver(row.id, this.events);
    else if (row.driver_type === "http") driver = new GenericHttpDriver(config as unknown as HttpDriverConfig);
    else if (row.driver_type === "pushplus") driver = new PushPlusDriver(config as unknown as PushPlusConfig, this.secrets);
    else if (row.driver_type === "vk87") driver = new Vk87Driver(config.profile);
    else return undefined;
    this.#cache.set(instanceId, driver);
    return driver;
  }

  invalidate(): void {
    for (const driver of this.#cache.values()) void driver.close?.();
    this.#cache.clear();
  }
}

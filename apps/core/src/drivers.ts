import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { AsyncEntry } from "@napi-rs/keyring";
import type { ActionPayload, DriverActionRequest, DriverActionResult } from "@state-hub/protocol";
import type { StateHubDatabase } from "./database.js";
import type { HubEventBus } from "./events.js";
import { authorizeHttpTarget, type ResolvedTargetAddress } from "./http-target-policy.js";
import type { PluginRuntime } from "./plugin-runtime.js";

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
    const effectiveAction = request.batch?.at(-1)?.action ?? request.action;
    if (effectiveAction) this.state.set(request.resourceChannel, effectiveAction);
    else this.state.delete(request.resourceChannel);
    this.events.publish("virtual.rendered", {
      driverInstanceId: this.instanceId,
      resourceChannel: request.resourceChannel,
      action: effectiveAction,
      ...(request.batch ? { batch: request.batch } : {}),
      ...(request.projectionRevision === undefined ? {} : { projectionRevision: request.projectionRevision }),
    });
    return { status: "delivered" };
  }
}

interface HttpDriverConfig {
  baseUrl: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  privateTargetOrigin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function pinnedJsonRequest(
  config: HttpDriverConfig,
  payload: unknown,
  resolveAddresses: (hostname: string) => Promise<ResolvedTargetAddress[]> = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<{ statusCode: number; body: string }> {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) targets are allowed");
  if (url.username || url.password) throw new Error("Credentials in target URLs are forbidden");
  const resolved = await resolveAddresses(url.hostname);
  const selected = authorizeHttpTarget(url, config.privateTargetOrigin, resolved);
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  for (const name of Object.keys(config.headers ?? {})) {
    if (/^host$/iu.test(name)) throw new Error("HTTP Host header must match the authorized target");
    if (/^(content-length|transfer-encoding|connection|upgrade)$/iu.test(name) ||
      /^proxy-/iu.test(name)) throw new Error("HTTP transport header cannot be overridden");
    if (/^(authorization|cookie|x-api-key)$/iu.test(name)) {
      throw new Error("Sensitive HTTP headers must use a credential reference, not inline configuration");
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
  constructor(
    private readonly config: HttpDriverConfig,
    private readonly resolveAddresses?: (hostname: string) => Promise<ResolvedTargetAddress[]>,
  ) {}

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    try {
      const response = await pinnedJsonRequest(this.config, {
        deliveryId: request.deliveryId,
        ...(request.producerId ? { producerId: request.producerId } : {}),
        ...(request.eventId ? { eventId: request.eventId } : {}),
        ...(request.eventRevision === undefined ? {} : { eventRevision: request.eventRevision }),
        channel: request.resourceChannel,
        actionKind: request.actionKind,
        action: request.action,
        ...(request.batchId ? { batchId: request.batchId } : {}),
        ...(request.batch ? { batch: request.batch } : {}),
        ...(request.projectionRevision === undefined ? {} : { projectionRevision: request.projectionRevision }),
      }, this.resolveAddresses);
      if (response.statusCode >= 200 && response.statusCode < 300) return { status: "delivered" };
      if (response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500) {
        return { status: "retry", detail: `HTTP ${response.statusCode}` };
      }
      return { status: "dead-letter", detail: `HTTP ${response.statusCode}` };
    } catch (error) {
      return { status: "retry", detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface PushPlusConfig {
  tokenSecretRef: string;
  topic?: string;
  endpoint?: string;
  privateTargetOrigin?: string;
}

export class PushPlusDriver implements Driver {
  constructor(
    private readonly config: PushPlusConfig,
    private readonly secrets: SecretProvider,
  ) {}

  async execute(request: DriverActionRequest): Promise<DriverActionResult> {
    let token: string | undefined;
    try { token = await this.secrets.get(this.config.tokenSecretRef); }
    catch { return { status: "dead-letter", detail: "CREDENTIAL_UNAVAILABLE" }; }
    if (!token) return { status: "dead-letter", detail: "CREDENTIAL_UNAVAILABLE" };
    const items = request.batch ?? [{
      deliveryId: request.deliveryId,
      ...(request.producerId ? { producerId: request.producerId } : {}),
      ...(request.eventId ? { eventId: request.eventId } : {}),
      ...(request.eventRevision === undefined ? {} : { eventRevision: request.eventRevision }),
      action: request.action,
      ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
    }];
    const params = items[0]?.action?.params ?? {};
    const contents = items.map((item) => String(item.action?.params.content ?? "")).filter(Boolean);
    try {
      const response = await pinnedJsonRequest(
        {
          baseUrl: this.config.endpoint ?? "https://www.pushplus.plus/send",
          ...(this.config.privateTargetOrigin ? { privateTargetOrigin: this.config.privateTargetOrigin } : {}),
          method: "POST",
          timeoutMs: 10_000,
        },
        {
          token,
          title: items.length > 1
            ? `${String(params.title ?? "State Hub")} (${items.length})`
            : String(params.title ?? "State Hub"),
          content: contents.join("\n\n"),
          ...(this.config.topic ? { topic: this.config.topic } : {}),
        },
      );
      if (response.statusCode >= 200 && response.statusCode < 300) {
        let receipt: unknown;
        try { receipt = JSON.parse(response.body); }
        catch { return { status: "retry", detail: "PUSHPLUS_INVALID_RESPONSE" }; }
        const code = receipt && typeof receipt === "object" && !Array.isArray(receipt)
          ? (receipt as { code?: unknown }).code : undefined;
        if (typeof code !== "number" || !Number.isInteger(code) || code < 100 || code > 999) {
          return { status: "retry", detail: "PUSHPLUS_INVALID_RESPONSE" };
        }
        if (code === 200) return { status: "delivered" };
        return { status: code === 500 ? "retry" : "dead-letter", detail: `PushPlus code ${code}` };
      }
      return response.statusCode === 429 || response.statusCode >= 500
        ? { status: "retry", detail: `PushPlus HTTP ${response.statusCode}` }
        : { status: "dead-letter", detail: `PushPlus HTTP ${response.statusCode}` };
    } catch {
      return { status: "retry", detail: "PUSHPLUS_TRANSPORT_FAILED" };
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("VK87 profile does not match the verified device selector");
  }
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
    const action = request.action?.name ?? "idle";
    if (request.actionKind !== "stateful" || !["completed", "decision", "idle"].includes(action)) {
      return { status: "dead-letter", detail: "VK87_ACTION_UNSUPPORTED" };
    }
    let module: typeof import("node-hid");
    try {
      module = await import("node-hid");
    } catch {
      return { status: "retry", detail: "node-hid is not available on this platform" };
    }
    let devices: ReturnType<typeof module.HID.devices>;
    try { devices = module.HID.devices(); }
    catch { return { status: "retry", detail: "VK87_ENUMERATION_FAILED" }; }
    const candidates = devices.filter(
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
    const reportHex =
      action === "completed"
        ? this.#profile.completedReportHex
        : action === "decision"
          ? this.#profile.decisionReportHex
          : this.#profile.restoreReportHex;
    let device: InstanceType<typeof module.HID>;
    try { device = new module.HID(candidates[0].path); }
    catch { return { status: "retry", detail: "VK87_OPEN_FAILED" }; }
    try {
      // node-hid includes the report ID differently in returned byte counts across backends.
      // The verified argument is always the complete 65-byte feature report.
      device.sendFeatureReport([...Buffer.from(reportHex, "hex")]);
      return { status: "delivered" };
    } catch {
      return { status: "retry", detail: "VK87_WRITE_FAILED" };
    } finally {
      try { device.close(); }
      catch { /* A completed write must not be retried because closing failed. */ }
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
  readonly #cache = new Map<string, { signature: string; driver: Driver }>();

  constructor(
    private readonly db: StateHubDatabase,
    private readonly events: HubEventBus,
    private readonly secrets: SecretProvider = new OsSecretProvider(),
    private readonly plugins?: PluginRuntime,
  ) {}

  get(instanceId: string): Driver | undefined {
    const row = this.db.raw.prepare("SELECT * FROM driver_instances WHERE id = ?").get(instanceId) as
      | InstanceRow
      | undefined;
    const cached = this.#cache.get(instanceId);
    if (!row || row.enabled !== 1) {
      if (cached) void cached.driver.close?.();
      this.#cache.delete(instanceId);
      return undefined;
    }
    const signature = JSON.stringify([row.driver_type, row.config_json]);
    if (cached?.signature === signature) return cached.driver;
    if (cached) void cached.driver.close?.();
    this.#cache.delete(instanceId);
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    const builtinType = row.driver_type.startsWith("official.") ? row.driver_type.slice("official.".length) :
      row.driver_type;
    let driver: Driver;
    if (builtinType === "virtual") driver = new VirtualDriver(row.id, this.events);
    else if (builtinType === "http") driver = new GenericHttpDriver(config as unknown as HttpDriverConfig);
    else if (builtinType === "pushplus") driver = new PushPlusDriver(config as unknown as PushPlusConfig, this.secrets);
    else if (builtinType === "vk87") driver = new Vk87Driver(config.profile);
    else if (this.plugins?.hasDriver(row.driver_type)) {
      driver = { execute: async (request) => await this.plugins!.execute(row.driver_type, request, config) };
    } else return undefined;
    this.#cache.set(instanceId, { signature, driver });
    return driver;
  }

  invalidate(): void {
    for (const entry of this.#cache.values()) void entry.driver.close?.();
    this.#cache.clear();
  }
}

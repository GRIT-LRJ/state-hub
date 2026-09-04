import type {
  DriverActionRequest,
  DriverActionResult,
  DriverDefinition,
  JsonRpcRequest,
  JsonRpcResponse,
  SourceDefinition,
} from "@state-hub/protocol";
import { PLUGIN_PROTOCOL_VERSION } from "@state-hub/protocol";

export type PluginMethod = (params: unknown) => unknown | Promise<unknown>;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (true) {
      const boundary = this.#buffer.indexOf("\r\n\r\n");
      if (boundary < 0) break;
      const header = this.#buffer.subarray(0, boundary).toString("ascii");
      const match = /^Content-Length:\s*(\d+)$/imu.exec(header);
      if (!match?.[1]) throw new Error("Missing Content-Length header");
      const length = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
        throw new Error("Invalid plugin frame length");
      }
      const bodyStart = boundary + 4;
      if (this.#buffer.length < bodyStart + length) break;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length);
      messages.push(JSON.parse(body.toString("utf8")) as unknown);
      this.#buffer = this.#buffer.subarray(bodyStart + length);
    }
    return messages;
  }
}

export interface StateHubPlugin {
  sourceDefinitions?: SourceDefinition[];
  driverDefinitions?: DriverDefinition[];
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  executeDriverAction?(request: DriverActionRequest): DriverActionResult | Promise<DriverActionResult>;
}

export function defineSource(definition: SourceDefinition): SourceDefinition {
  return definition;
}

export function defineDriver(definition: DriverDefinition): DriverDefinition {
  return definition;
}

export function definePlugin(plugin: StateHubPlugin): StateHubPlugin {
  return plugin;
}

export class PluginRpcServer {
  readonly #methods = new Map<string, PluginMethod>();

  constructor(private readonly plugin: StateHubPlugin) {
    this.#methods.set("statehub.initialize", async (params) => {
      const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      if (requested !== PLUGIN_PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${requested ?? "missing"}`);
      await plugin.start?.();
      return {
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        sourceDefinitions: plugin.sourceDefinitions ?? [],
        driverDefinitions: plugin.driverDefinitions ?? [],
      };
    });
    this.#methods.set("statehub.health", () => ({ status: "ok" }));
    this.#methods.set("statehub.stop", async () => {
      await plugin.stop?.();
      return { stopped: true };
    });
    this.#methods.set("driver.execute", async (params) => {
      if (!plugin.executeDriverAction) throw new Error("Plugin does not expose a driver");
      return await plugin.executeDriverAction(params as DriverActionRequest);
    });
  }

  register(method: string, handler: PluginMethod): void {
    if (method.startsWith("statehub.")) throw new Error("Reserved method namespace");
    this.#methods.set(method, handler);
  }

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const method = this.#methods.get(request.method);
    if (!method) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
    }
    try {
      return { jsonrpc: "2.0", id: request.id, result: await method(request.params) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}

export function runPlugin(plugin: StateHubPlugin): void {
  const server = new PluginRpcServer(plugin);
  const decoder = new FrameDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        void server.handle(message as JsonRpcRequest).then((response) => process.stdout.write(encodeFrame(response)));
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}

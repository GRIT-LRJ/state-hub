import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PushPlusDriver, type SecretProvider } from "./drivers.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function target(replyBody = '{"code":200}', statusCode = 200):
  Promise<{ endpoint: string; origin: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(statusCode, { "content-type": "application/json" }).end(replyBody);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { endpoint: `${origin}/send`, origin, requests };
}

const action = {
  deliveryId: "pushplus-delivery",
  driverInstanceId: "pushplus-main",
  resourceChannel: "notifications",
  actionKind: "append-only" as const,
  action: { name: "send", params: { content: "notification" } },
};

describe("PushPlus OS credential boundary", () => {
  it("sends only after a credential read succeeds", async () => {
    const probe = await target();
    const secrets: SecretProvider = { get: async () => "credential-only-in-memory" };
    const driver = new PushPlusDriver({ tokenSecretRef: "pushplus:main",
      endpoint: probe.endpoint, privateTargetOrigin: probe.origin }, secrets);
    expect((await driver.execute(action)).status).toBe("delivered");
    expect(probe.requests).toEqual([expect.objectContaining({
      token: "credential-only-in-memory", content: "notification",
    })]);
  });

  it.each([
    ["invalid token", '{"code":903,"msg":"private-provider-message"}', 200,
      { status: "dead-letter", detail: "PushPlus code 903" }],
    ["provider failure", '{"code":500,"msg":"private-provider-message"}', 200,
      { status: "retry", detail: "PushPlus code 500" }],
    ["rate restricted", '{"code":900,"msg":"private-provider-message"}', 200,
      { status: "dead-letter", detail: "PushPlus code 900" }],
    ["malformed response", "private-provider-message", 200,
      { status: "retry", detail: "PUSHPLUS_INVALID_RESPONSE" }],
    ["empty success", "", 204,
      { status: "retry", detail: "PUSHPLUS_INVALID_RESPONSE" }],
  ] as const)("classifies %s without exposing provider text", async (_name, body, statusCode, expected) => {
    const probe = await target(body, statusCode);
    const driver = new PushPlusDriver({ tokenSecretRef: "pushplus:main",
      endpoint: probe.endpoint, privateTargetOrigin: probe.origin },
    { get: async () => "credential-only-in-memory" });
    expect(await driver.execute(action)).toEqual(expected);
    expect(probe.requests).toHaveLength(1);
  });

  it.each([
    ["missing", { get: async (): Promise<string | undefined> => undefined }],
    ["read failure", { get: async (): Promise<string | undefined> => {
      throw new Error("untrusted credential error with secret");
    } }],
  ] as const)("does not call HTTP when the secret is %s", async (_case, secrets) => {
    const probe = await target();
    const driver = new PushPlusDriver({ tokenSecretRef: "pushplus:main",
      endpoint: probe.endpoint, privateTargetOrigin: probe.origin }, secrets);
    expect(await driver.execute(action)).toEqual({ status: "dead-letter", detail: "CREDENTIAL_UNAVAILABLE" });
    expect(probe.requests).toHaveLength(0);
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GenericHttpDriver } from "./drivers.js";
import { authorizeHttpTarget } from "./http-target-policy.js";

const request = {
  deliveryId: "delivery",
  driverInstanceId: "http",
  resourceChannel: "probe",
  actionKind: "queued-effect" as const,
  action: { name: "send", params: {} },
};

describe("Generic HTTP target policy", () => {
  it.each([
    ["127.0.0.1", 4], ["10.2.3.4", 4], ["172.31.255.1", 4],
    ["192.168.1.1", 4], ["::1", 6], ["fd12::1", 6],
    ["::ffff:127.0.0.1", 6], ["::ffff:10.2.3.4", 6],
    ["169.254.169.254", 4], ["fe80::1", 6],
    ["192.0.2.1", 4], ["198.18.0.1", 4], ["2001:db8::1", 6],
    ["3fff::1", 6], ["::ffff:169.254.169.254", 6],
  ])("rejects %s by default", (address, family) => {
    expect(() => authorizeHttpTarget(new URL("http://target.example:8080/hook"), undefined, [{ address, family }]))
      .toThrow(/blocked/u);
  });

  it("requires an exact normalized scheme, host, and port grant", () => {
    const target = new URL("https://EXAMPLE.test:443/hook");
    const privateAnswer = [{ address: "10.1.2.3", family: 4 }];
    expect(authorizeHttpTarget(target, "https://example.test:443", privateAnswer)).toEqual(privateAnswer[0]);
    for (const grant of ["http://example.test", "https://other.test", "https://example.test:444", "https://example.test/path", "https://user:pass@example.test"])
      expect(() => authorizeHttpTarget(target, grant, privateAnswer)).toThrow(/grant/u);
    expect(() => authorizeHttpTarget(target, undefined, privateAnswer)).toThrow(/blocked/u);
  });

  it("never grants link-local, metadata, or special-use addresses", () => {
    const target = new URL("http://target.example:8080/hook");
    for (const [address, family] of [["169.254.169.254", 4], ["fe80::1", 6], ["192.0.2.1", 4]] as const)
      expect(() => authorizeHttpTarget(target, target.origin, [{ address, family }])).toThrow(/blocked/u);
  });

  it("rejects every unsafe DNS answer, including later answers and mixed public/private answers", () => {
    const target = new URL("http://target.example:8080/hook");
    expect(() => authorizeHttpTarget(target, undefined, [
      { address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 },
    ])).toThrow(/blocked/u);
    expect(() => authorizeHttpTarget(target, target.origin, [
      { address: "8.8.8.8", family: 4 }, { address: "10.1.2.3", family: 4 },
    ])).toThrow(/Mixed/u);
    expect(authorizeHttpTarget(target, undefined, [{ address: "2001:4860:4860::8888", family: 6 }]))
      .toEqual({ address: "2001:4860:4860::8888", family: 6 });
    expect(() => authorizeHttpTarget(target, undefined, [{ address: "8.8.8.8", family: 6 }])).toThrow(/blocked/u);
  });
});

describe("Generic HTTP pinned transport", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("connects to the checked address without resolving the hostname again", async () => {
    const received: string[] = [];
    const server = createServer((incoming, response) => {
      received.push(String(incoming.headers.host));
      response.writeHead(204).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let resolutions = 0;
    const driver = new GenericHttpDriver(
      { baseUrl: `http://approved.example:${port}/hook`, privateTargetOrigin: `http://approved.example:${port}` },
      async () => { resolutions++; return [{ address: "127.0.0.1", family: 4 }]; },
    );
    expect((await driver.execute(request)).status).toBe("delivered");
    expect(resolutions).toBe(1);
    expect(received).toEqual([`approved.example:${port}`]);
  });

  it("rejects a configured Host override before network I/O", async () => {
    let received = 0;
    const server = createServer((_incoming, response) => { received++; response.writeHead(204).end(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const driver = new GenericHttpDriver({
      baseUrl: `http://127.0.0.1:${port}/hook`,
      privateTargetOrigin: `http://127.0.0.1:${port}`,
      headers: { Host: "other.internal" },
    });
    expect(await driver.execute(request)).toMatchObject({ status: "retry", detail: expect.stringMatching(/Host/u) });
    expect(received).toBe(0);
  });

  it("refuses a changed DNS answer before sending a request", async () => {
    let received = 0;
    const server = createServer((_incoming, response) => { received++; response.writeHead(204).end(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let answer: string = "127.0.0.1";
    const driver = new GenericHttpDriver(
      { baseUrl: `http://approved.example:${port}`, privateTargetOrigin: `http://approved.example:${port}` },
      async () => [{ address: answer, family: 4 }],
    );
    expect((await driver.execute(request)).status).toBe("delivered");
    answer = "169.254.169.254";
    expect(await driver.execute(request)).toMatchObject({ status: "retry", detail: expect.stringMatching(/blocked/u) });
    expect(received).toBe(1);
  });
});

// https://fetch.spec.whatwg.org/#port-blocking
// Windows can assign ports in this list for an ephemeral listener. WebView and
// Node fetch then reject the URL even though the server is listening.
const blockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
  4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

export function isFetchAllowedPort(port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 && !blockedPorts.has(port);
}

interface Listener {
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<unknown>;
}

export async function listenFetchCompatible<T extends Listener>(
  create: () => T,
  host: string,
  requestedPort: number,
  maxAttempts = 16,
): Promise<{ app: T; address: string; port: number }> {
  if (requestedPort !== 0 && !isFetchAllowedPort(requestedPort)) {
    throw new Error("Core HTTP port is unavailable to Fetch clients");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const app = create();
    let address: string;
    try {
      address = await app.listen({ host, port: requestedPort });
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
    const port = Number.parseInt(new URL(address).port, 10);
    if (isFetchAllowedPort(port)) return { app, address, port };
    await app.close();
  }
  throw new Error("Could not allocate a Fetch-compatible Core port");
}

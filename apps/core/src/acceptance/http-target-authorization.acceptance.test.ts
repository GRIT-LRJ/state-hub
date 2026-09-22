import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Binding } from "@state-hub/protocol";
import { describe, expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

describe("Generic HTTP concrete target authorization through Core", () => {
  it("rejects the legacy broad switch before network I/O, then delivers with an exact grant", async () => {
    let received = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain the body */ }
      received++;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}/append`;
    const harness = await CoreAcceptanceHarness.start();
    try {
      const binding: Binding = {
        id: "http-target-probe",
        name: "HTTP target probe",
        enabled: true,
        selector: { producerId: "http-target-producer", eventType: "http.target", scopePattern: "*" },
        conditions: [],
        mapping: { value: { kind: "pointer", pointer: "/value" } },
        target: {
          driverInstanceId: "http-target",
          resourceChannel: "probe",
          actionKind: "append-only",
          actionName: "append",
        },
        batchWindowMs: 0,
      };
      const producer = await harness.admin.createProducer("http-target-producer");
      const publish = async (config: Record<string, unknown>) => harness.admin.publishConfig({
        bindings: [binding],
        driverInstances: [{ id: "http-target", driverType: "http", enabled: true, config: { baseUrl, ...config } }],
      });
      await publish({ allowPrivateNetwork: true });
      const accepted = await producer.emitEvent({ eventId: "target-probe-1", type: "http.target", value: { value: 1 } });
      expect(accepted.response.status).toBe(202);
      await harness.waitFor(async () => {
        const diagnostics = await harness.admin.diagnostics();
        return (diagnostics.deliveries as Array<{ attemptCount: number }>).some((delivery) => delivery.attemptCount >= 1);
      }, { description: "legacy private switch to be rejected" });
      expect(received).toBe(0);

      await publish({ privateTargetOrigin: `http://127.0.0.1:${port}` });
      await harness.waitFor(() => received === 1, { description: "exactly one granted HTTP request", timeoutMs: 15_000 });
      await harness.waitFor(async () => (await harness.admin.snapshot()).pendingDeliveries === 0, {
        description: "granted delivery to settle",
      });
      expect(received).toBe(1);
    } finally {
      await harness.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

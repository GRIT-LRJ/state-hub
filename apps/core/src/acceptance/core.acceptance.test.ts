import { existsSync } from "node:fs";
import type { Binding } from "@state-hub/protocol";
import { expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

const binding: Binding = {
  id: "acceptance-status",
  name: "Acceptance status",
  enabled: true,
  selector: { producerId: "acceptance", signalId: "status", scopePattern: "*" },
  conditions: [],
  mapping: { phase: { kind: "pointer", pointer: "/phase" } },
  target: {
    driverInstanceId: "virtual-main",
    resourceChannel: "acceptance-light",
    actionKind: "stateful",
    actionName: "render",
  },
};

it("drives an authenticated claim through the real Core process before and after restart", async () => {
  const harness = await CoreAcceptanceHarness.start();
  const temporaryRoot = harness.paths.root;
  let failed = false;

  try {
    expect(harness.processId).not.toBe(process.pid);
    expect(harness.discovery.host).toBe("127.0.0.1");
    expect(harness.discovery.port).toBeGreaterThan(0);
    expect(harness.discovery.port).not.toBe(3000);
    expect(harness.paths.database.startsWith(temporaryRoot)).toBe(true);

    const unauthorized = await harness.fetch(
      "/api/v1/producers/acceptance/scopes/session-1/claims/status",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: { phase: "decision" } }),
      },
    );
    expect(unauthorized.status).toBe(401);

    const producer = await harness.admin.createProducer("acceptance");
    await harness.admin.publishConfig({
      bindings: [binding],
      driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
    });

    const events = await harness.observeEvents();
    await events.waitFor("snapshot");
    const accepted = await producer.upsertClaim("session-1", "status", {
      value: { phase: "decision" },
      urgency: "action-required",
    });
    expect(accepted.response.status).toBe(202);
    expect((await producer.command(accepted.body.commandId)).status).toBe("applied");

    const changed = await events.waitFor("snapshot.changed", (data) => {
      const snapshot = data as { claims?: Array<{ value?: unknown }> };
      return snapshot.claims?.some((claim) => JSON.stringify(claim.value) === '{"phase":"decision"}') ?? false;
    });
    expect(changed.type).toBe("snapshot.changed");
    const firstRender = await events.waitFor("virtual.rendered");
    expect(firstRender.data).toMatchObject({
      driverInstanceId: "virtual-main",
      resourceChannel: "acceptance-light",
      action: { name: "render", params: { phase: "decision" } },
    });
    const snapshot = await harness.waitFor(async () => {
      const current = await harness.admin.snapshot();
      return current.pendingDeliveries === 0 ? current : false;
    });
    expect(snapshot.claims).toContainEqual(expect.objectContaining({
      producerId: "acceptance",
      scopeId: "session-1",
      signalId: "status",
      value: { phase: "decision" },
    }));
    expect(snapshot.projections).toContainEqual(expect.objectContaining({
      driverInstanceId: "virtual-main",
      resourceChannel: "acceptance-light",
      action: { name: "render", params: { phase: "decision" } },
    }));

    const firstPid = harness.processId;
    await harness.stop();
    expect(harness.isRunning).toBe(false);
    expect(existsSync(harness.paths.discovery)).toBe(false);

    await harness.restart();
    expect(harness.processId).not.toBe(firstPid);
    const recovered = await harness.admin.snapshot();
    expect(recovered.claims).toContainEqual(expect.objectContaining({
      producerId: "acceptance",
      scopeId: "session-1",
      signalId: "status",
      value: { phase: "decision" },
    }));

    const restartedEvents = await harness.observeEvents();
    await restartedEvents.waitFor("snapshot");
    const restartedAccepted = await producer.upsertClaim("session-1", "status", {
      value: { phase: "completed" },
      urgency: "informational",
    });
    expect(restartedAccepted.response.status).toBe(202);
    expect((await producer.command(restartedAccepted.body.commandId)).status).toBe("applied");
    const restartedRender = await restartedEvents.waitFor("virtual.rendered");
    expect(restartedRender.data).toMatchObject({
      action: { name: "render", params: { phase: "completed" } },
    });

    await harness.crash();
    expect(harness.isRunning).toBe(false);
    expect(existsSync(harness.paths.discovery)).toBe(true);

    await harness.restart();
    expect((await harness.admin.snapshot()).claims).toContainEqual(expect.objectContaining({
      producerId: "acceptance",
      scopeId: "session-1",
      signalId: "status",
      value: { phase: "completed" },
    }));
    await harness.stop();
    expect(existsSync(harness.paths.discovery)).toBe(false);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await harness.dispose();
    } catch (cleanupError) {
      if (failed) {
        console.error("Acceptance harness cleanup failed after a test failure:", cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }

  expect(existsSync(temporaryRoot)).toBe(false);
}, 30_000);

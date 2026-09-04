import type { Binding } from "@state-hub/protocol";
import { expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

function binding(id: string, signalId: string, resourceChannel: string, order = 0): Binding {
  return {
    id,
    name: id,
    enabled: true,
    selector: { producerId: "ttl-acceptance", signalId, scopePattern: "*" },
    conditions: [],
    mapping: { phase: { kind: "pointer", pointer: "/phase" } },
    target: {
      driverInstanceId: "virtual-main",
      resourceChannel,
      actionKind: "stateful",
      actionName: "render",
    },
    order,
  };
}

it("actively expires, falls back, arbitrates by claim revision, and recovers TTL policies after restart", async () => {
  const harness = await CoreAcceptanceHarness.start();
  let failed = false;

  try {
    const producer = await harness.admin.createProducer("ttl-acceptance");
    await harness.admin.publishConfig({
      bindings: [
        binding("status", "status", "status"),
        binding("restart-fallback", "restart-fallback", "restart-deactivate", -1),
        binding("restart-deactivate", "restart-deactivate", "restart-deactivate"),
        binding("restart-demote", "restart-demote", "restart-demote"),
        binding("restart-retain", "restart-retain", "restart-retain"),
      ],
      driverInstances: [{ id: "virtual-main", driverType: "virtual", enabled: true, config: {} }],
    });

    const events = await harness.observeEvents();
    await events.waitFor("snapshot");
    await producer.upsertClaim("fallback", "status", {
      value: { phase: "fallback" },
      urgency: "ambient",
    });
    const expiring = await producer.upsertClaim("expiring", "status", {
      value: { phase: "expiring" },
      urgency: "critical",
      expiresAt: new Date(Date.now() + 700).toISOString(),
      stalePolicy: "deactivate",
    });
    expect(expiring.response.status).toBe(202);
    expect((await producer.command(expiring.body.commandId)).status).toBe("applied");
    await events.waitFor("virtual.rendered", (data) =>
      (data as { action?: { params?: { phase?: string } } }).action?.params?.phase === "expiring",
    );

    await events.waitFor("claims.expired");
    await events.waitFor("snapshot.changed", (data) =>
      (data as { projections?: Array<{ action?: { params?: { phase?: string } } }> }).projections
        ?.some((projection) => projection.action?.params?.phase === "fallback") ?? false,
    );
    await events.waitFor("virtual.rendered", (data) =>
      (data as { action?: { params?: { phase?: string } } }).action?.params?.phase === "fallback",
    );

    await producer.upsertClaim("a-older", "status", {
      value: { phase: "older" },
      urgency: "critical",
    });
    await producer.upsertClaim("z-newer", "status", {
      value: { phase: "newer" },
      urgency: "critical",
    });
    const revisionWinner = await harness.waitFor(async () => {
      const snapshot = await harness.admin.snapshot();
      const projection = snapshot.projections.find((item) => item.resourceChannel === "status");
      return projection?.action?.params.phase === "newer" ? projection : false;
    }, { description: "latest claim revision to win arbitration" });
    expect(revisionWinner.contributorClaimKeys).toContain("ttl-acceptance\u001fz-newer\u001fstatus");

    await producer.upsertClaim("fallback", "restart-fallback", {
      value: { phase: "restart-fallback" },
      urgency: "ambient",
    });
    const restartExpiry = new Date(Date.now() + 1_500).toISOString();
    await producer.upsertClaim("deactivate", "restart-deactivate", {
      value: { phase: "restart-deactivate" },
      urgency: "critical",
      expiresAt: restartExpiry,
      stalePolicy: "deactivate",
    });
    await producer.upsertClaim("demote", "restart-demote", {
      value: { phase: "restart-demote" },
      urgency: "critical",
      expiresAt: restartExpiry,
      stalePolicy: "demote",
    });
    await producer.upsertClaim("retain", "restart-retain", {
      value: { phase: "restart-retain" },
      urgency: "critical",
      expiresAt: restartExpiry,
      stalePolicy: "retain",
    });

    await harness.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await harness.restart();
    const recovered = await harness.admin.snapshot();
    expect(recovered.projections.find((item) => item.resourceChannel === "status")?.action?.params)
      .toEqual({ phase: "newer" });
    expect(recovered.projections.find((item) => item.resourceChannel === "restart-deactivate"))
      .toMatchObject({ action: { name: "render", params: { phase: "restart-fallback" } }, urgency: "ambient" });
    expect(recovered.projections.find((item) => item.resourceChannel === "restart-demote"))
      .toMatchObject({ action: { name: "render", params: { phase: "restart-demote" } }, urgency: "action-required" });
    expect(recovered.projections.find((item) => item.resourceChannel === "restart-retain"))
      .toMatchObject({ action: { name: "render", params: { phase: "restart-retain" } }, urgency: "critical" });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await harness.dispose();
    } catch (cleanupError) {
      if (failed) console.error("TTL acceptance cleanup failed after a test failure:", cleanupError);
      else throw cleanupError;
    }
  }
}, 30_000);

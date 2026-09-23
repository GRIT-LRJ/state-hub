import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Binding } from "@state-hub/protocol";
import { StateHubDatabase } from "./database.js";
import { registerProducer } from "./auth.js";
import { HubEventBus } from "./events.js";
import { HubError, StateHubService, type PublishedConfig } from "./service.js";

const binding: Binding = {
  id: "status", name: "status", enabled: true,
  selector: { producerId: "producer", signalId: "status", scopePattern: "*" },
  conditions: [], mapping: { phase: { kind: "pointer", pointer: "/phase" } },
  target: { driverInstanceId: "display", resourceChannel: "light",
    actionKind: "stateful", actionName: "render" },
};

const base: PublishedConfig = {
  driverInstances: [{ id: "display", driverType: "virtual", enabled: true, config: {} }],
  bindings: [binding],
};

function copy(): PublishedConfig {
  return structuredClone(base);
}

describe("complete config validation and atomic revision", () => {
  let db: StateHubDatabase;
  let service: StateHubService;

  beforeEach(() => {
    db = new StateHubDatabase(":memory:");
    service = new StateHubService(db, new HubEventBus());
  });

  afterEach(() => db.close());

  function rejected(config: unknown, code: string): void {
    try {
      service.createConfigDraft(config as PublishedConfig);
      throw new Error("configuration was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(HubError);
      expect(error).toMatchObject({ code });
    }
    expect(db.raw.prepare("SELECT count(*) AS n FROM config_revisions").get()).toMatchObject({ n: 0 });
  }

  it("rejects a draft if another revision published after its preview, regardless of draft number", () => {
    const initial = service.createConfigDraft(copy());
    service.publishConfig(initial.revision);
    const older = service.createConfigDraft({ ...copy(), bindings: [] });
    const newerConfig = copy();
    newerConfig.bindings[0]!.name = "newer";
    const newer = service.createConfigDraft(newerConfig);
    service.publishConfig(older.revision);
    expect(() => service.publishConfig(newer.revision)).toThrowError(
      expect.objectContaining({ code: "CONFIG_STALE_DRAFT" }));
    expect(service.exportConfig().bindings).toEqual([]);

    const third = service.createConfigDraft(newerConfig);
    const fourth = service.createConfigDraft(copy());
    service.publishConfig(fourth.revision);
    expect(() => service.publishConfig(third.revision)).toThrowError(
      expect.objectContaining({ code: "CONFIG_STALE_DRAFT" }));
    expect(service.exportConfig().bindings).toEqual(copy().bindings);

    const legacy = service.createConfigDraft({ ...copy(), bindings: [] });
    db.raw.prepare("UPDATE config_revisions SET impact_json = '{}' WHERE revision = ?").run(legacy.revision);
    expect(() => service.publishConfig(legacy.revision)).toThrowError(
      expect.objectContaining({ code: "CONFIG_STALE_DRAFT" }));
  });

  it("rejects malformed config, driver schemas, action contracts and missing references before saving a draft", () => {
    rejected({ bindings: [] }, "INVALID_CONFIG_SHAPE");
    const badDriver = copy();
    badDriver.driverInstances[0]!.config = { unexpected: true };
    rejected(badDriver, "INVALID_DRIVER_CONFIG");
    const badProfile = copy();
    badProfile.driverInstances[0]!.driverType = "vk87";
    badProfile.driverInstances[0]!.config = { profile: {} };
    rejected(badProfile, "INVALID_DRIVER_CONFIG");
    const credentialUrl = copy();
    credentialUrl.driverInstances[0]!.driverType = "http";
    credentialUrl.driverInstances[0]!.config = { baseUrl: "http://user:password@example.com/" };
    rejected(credentialUrl, "INVALID_DRIVER_CONFIG");
    const unsafeHeader = copy();
    unsafeHeader.driverInstances[0]!.driverType = "http";
    unsafeHeader.driverInstances[0]!.config = { baseUrl: "https://example.com/",
      headers: { "Content-Length": "0" } };
    rejected(unsafeHeader, "INVALID_DRIVER_CONFIG");
    const badAction = copy();
    badAction.bindings[0]!.target.actionName = "invented";
    rejected(badAction, "INVALID_ACTION_CONTRACT");
    const wrongKind = copy();
    wrongKind.bindings[0]!.target.actionKind = "append-only";
    rejected(wrongKind, "INVALID_ACTION_CONTRACT");
    const missingInstance = copy();
    missingInstance.bindings[0]!.target.driverInstanceId = "missing";
    rejected(missingInstance, "UNKNOWN_DRIVER_INSTANCE");
    const missingSource = copy();
    missingSource.bindings[0]!.selector.sourceType = "missing";
    rejected(missingSource, "UNKNOWN_SOURCE_TYPE");
    const missingSignal = copy();
    missingSignal.bindings[0]!.selector.sourceType = "official.codex";
    missingSignal.bindings[0]!.selector.signalId = "missing";
    rejected(missingSignal, "UNKNOWN_SOURCE_SIGNAL");
  });

  it("rejects unsafe mapping and physical conflicts without leaking provided values", () => {
    const badPointer = copy();
    badPointer.bindings[0]!.mapping.phase = { kind: "pointer", pointer: "phase" };
    rejected(badPointer, "INVALID_JSON_POINTER");
    const badTemplate = copy();
    badTemplate.bindings[0]!.mapping.phase = { kind: "template", template: "{{phase}}" };
    rejected(badTemplate, "INVALID_JSON_POINTER");
    const statefulEvent = copy();
    statefulEvent.bindings[0]!.selector = { eventType: "notice" };
    rejected(statefulEvent, "INVALID_SELECTOR");
    const unsafeWindow = copy();
    unsafeWindow.bindings[0]!.target = { ...unsafeWindow.bindings[0]!.target,
      actionKind: "append-only", actionName: "notify" };
    unsafeWindow.bindings[0]!.batchWindowMs = Number.MAX_SAFE_INTEGER + 1;
    rejected(unsafeWindow, "INVALID_BATCH_WINDOW");
    const badPhysical = copy();
    badPhysical.driverInstances.push({ id: "second", driverType: "virtual", enabled: true,
      config: {}, physicalResourceKey: "same-device" });
    badPhysical.driverInstances[0]!.physicalResourceKey = "same-device";
    rejected(badPhysical, "PHYSICAL_RESOURCE_CONFLICT");
    const conflictingBindings = copy();
    conflictingBindings.bindings[0]!.target.physicalResourceKey = "shared-output";
    conflictingBindings.bindings.push({ ...binding, id: "second",
      target: { ...binding.target, driverInstanceId: "second", physicalResourceKey: "shared-output" } });
    conflictingBindings.driverInstances.push({ id: "second", driverType: "virtual", enabled: true, config: {} });
    rejected(conflictingBindings, "PHYSICAL_RESOURCE_CONFLICT");
    const sameInstanceConflict = copy();
    sameInstanceConflict.bindings[0]!.target.physicalResourceKey = "shared-output";
    sameInstanceConflict.bindings.push({ ...binding, id: "different-channel",
      target: { ...binding.target, resourceChannel: "other", physicalResourceKey: "shared-output" } });
    rejected(sameInstanceConflict, "PHYSICAL_RESOURCE_CONFLICT");
    const badConstant = copy();
    badConstant.driverInstances[0]!.driverType = "pushplus";
    badConstant.driverInstances[0]!.config = { tokenSecretRef: "credential-reference" };
    badConstant.bindings[0]!.target = { ...badConstant.bindings[0]!.target,
      actionKind: "append-only", actionName: "send" };
    badConstant.bindings[0]!.mapping = { content: { kind: "constant", value: 12 } };
    rejected(badConstant, "INVALID_ACTION_MAPPING");
  });

  it("rolls back a producer event when its dynamic mapping violates the driver action schema", () => {
    const config: PublishedConfig = {
      driverInstances: [{ id: "notifier", driverType: "pushplus", enabled: true,
        config: { tokenSecretRef: "credential-reference" } }],
      bindings: [{
        ...binding, selector: { producerId: "producer", eventType: "notice" },
        mapping: { content: { kind: "pointer", pointer: "/content" } },
        target: { driverInstanceId: "notifier", resourceChannel: "notices",
          actionKind: "append-only", actionName: "send" },
      }],
    };
    const draft = service.createConfigDraft(config);
    service.publishConfig(draft.revision);
    registerProducer(db, "producer", "long-random-test-producer-token");
    expect(() => service.emitEvent("producer", "long-random-test-producer-token",
      { eventId: "same-event", type: "notice", value: { content: 12 } }))
      .toThrow("Mapped action does not satisfy its driver contract");
    expect(db.raw.prepare("SELECT count(*) AS n FROM occurrence_events").get()).toMatchObject({ n: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM deliveries").get()).toMatchObject({ n: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM event_dedupe").get()).toMatchObject({ n: 0 });
    expect(service.emitEvent("producer", "long-random-test-producer-token",
      { eventId: "same-event", type: "notice", value: { content: "safe" } }).status).toBe("accepted");
    expect(db.raw.prepare("SELECT count(*) AS n FROM deliveries").get()).toMatchObject({ n: 1 });
  });

  it("refuses to call an unissued draft a rollback source", () => {
    const draft = service.createConfigDraft(copy());
    expect(() => service.createRollbackDraft(draft.revision)).toThrow("Configuration revision not found");
    service.publishConfig(draft.revision);
    const rollback = service.createRollbackDraft(draft.revision);
    expect(rollback.revision).toBeGreaterThan(draft.revision);
  });

  it("includes claims that only the new selector will match in the impact preview", () => {
    const initial = service.createConfigDraft(copy());
    service.publishConfig(initial.revision);
    registerProducer(db, "producer", "long-random-test-producer-token");
    service.upsertClaim("producer", "long-random-test-producer-token", "scope", "other",
      { value: { phase: "working" } });
    const next = copy();
    next.bindings[0]!.selector.signalId = "other";
    const draft = service.createConfigDraft(next);
    expect(draft.impact).toMatchObject({ bindingsUpdated: ["status"],
      currentClaimsReevaluated: 1, currentClaimsAffected: 1, historicalEventsReplayed: 0 });
  });

  it("previews affected live claims and keeps published config atomic and immutable on failed publish", () => {
    const initial = service.createConfigDraft(copy());
    service.publishConfig(initial.revision);
    registerProducer(db, "producer", "long-random-test-producer-token");
    service.upsertClaim("producer", "long-random-test-producer-token", "scope", "status",
      { value: { phase: "working" } });
    const revision = db.raw.prepare("SELECT config_json FROM config_revisions WHERE revision = ?")
      .get(initial.revision) as { config_json: string };
    const next = copy();
    next.bindings[0]!.mapping.phase = { kind: "constant", value: "updated" };
    next.bindings.push({ ...binding, id: "other", selector: { signalId: "other" } });
    const draft = service.createConfigDraft(next);
    expect(draft.impact).toMatchObject({ bindingsAdded: ["other"], bindingsRemoved: [],
      bindingsUpdated: ["status"], currentClaimsReevaluated: 1,
      currentClaimsAffected: 1, historicalEventsReplayed: 0 });
    db.raw.prepare("UPDATE config_revisions SET config_json = ? WHERE revision = ?")
      .run(JSON.stringify({ driverInstances: [], bindings: [binding] }), draft.revision);
    expect(() => service.publishConfig(draft.revision)).toThrow("Configuration validation failed");
    expect(service.exportConfig()).toEqual(base);
    expect(db.raw.prepare("SELECT config_json FROM config_revisions WHERE revision = ?")
      .get(initial.revision)).toMatchObject(revision);
    expect(db.raw.prepare("SELECT status FROM config_revisions WHERE revision = ?")
      .get(initial.revision)).toMatchObject({ status: "published" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshot, getConnection, mergeCodexVirtual, subscribe, type CoreConnection } from "./api.js";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it.each([401, 403, 500])("classifies readable HTTP %s for both snapshot and subscription without exposing bodies", async (status) => {
  const connection = { endpoint: "http://127.0.0.1:41000", adminToken: "secret", generation: 1 };
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private server detail", { status })));
  const code = status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "UNAVAILABLE";
  await expect(fetchSnapshot(connection)).rejects.toMatchObject({ code, message: code });
  await expect(subscribe(connection, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code, message: code });
});

it.each(["CORE_STARTING", "CORE_RESTART_EXHAUSTED", "CORE_INTERNAL_ERROR", "private native detail"])
  ("maps only known native codes: %s", async (nativeError) => {
    vi.mocked(invoke).mockRejectedValueOnce(nativeError);
    const code = nativeError.startsWith("CORE_") ? nativeError : "UNAVAILABLE";
    await expect(getConnection()).rejects.toMatchObject({ code, message: code });
  });

describe("desktop SSE notice parser", () => {
  it("refreshes for initial snapshot and later events, ignoring heartbeats and data text", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\r\n\r\nevent: snapshot\r"));
        controller.enqueue(encoder.encode("\ndata: {\"revision\":1}\r\n\r\n"));
        controller.enqueue(encoder.encode("data: {\"text\":\"event: fake\"}\n\n"));
        controller.enqueue(encoder.encode("event: delivery.recovered\ndata: {}\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const connection: CoreConnection = {
      endpoint: "http://127.0.0.1:41000", adminToken: "private-test-token", generation: 3,
    };
    let notices = 0;
    await subscribe(connection, () => { notices += 1; }, new AbortController().signal);
    expect(notices).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:41000/api/v1/admin/events");
  });
});


describe("Codex Virtual quickstart merge", () => {
  it("keeps existing outputs and user-edited Codex mapping", () => {
    const current = {
      driverInstances: [
        { id: "virtual-main", driverType: "virtual", enabled: false, config: {} },
        { id: "other", driverType: "http", enabled: true, config: { baseUrl: "https://example.org" } },
      ],
      bindings: [{
        id: "codex-status-to-virtual", name: "customized", enabled: true,
        selector: { producerId: "codex", signalId: "status" }, conditions: [],
        mapping: { phase: { kind: "constant" as const, value: "custom" } },
        target: { driverInstanceId: "virtual-main", resourceChannel: "codex-status",
          actionKind: "stateful" as const, actionName: "render" },
      }],
    };
    const merged = mergeCodexVirtual(current);
    expect(merged.driverInstances).toEqual([
      { ...current.driverInstances[0], enabled: true }, current.driverInstances[1],
    ]);
    expect(merged.bindings).toEqual(current.bindings);
    expect(() => mergeCodexVirtual({ ...current, driverInstances: [
      { id: "virtual-main", driverType: "http", enabled: true, config: {} },
    ] })).toThrow("VIRTUAL_INSTANCE_ID_CONFLICT");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribe, type CoreConnection } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

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

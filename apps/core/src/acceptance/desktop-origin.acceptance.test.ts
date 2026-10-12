import { expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

it("allows the private desktop browser's preflight, authenticated JSON and SSE without opening other origins", async () => {
  const harness = await CoreAcceptanceHarness.start();
  try {
    for (const origin of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]) {
      const preflight = await harness.fetch("/api/v1/admin/snapshot", { method: "OPTIONS", headers: {
        origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization",
      } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
      const unauthorized = await harness.fetch("/api/v1/admin/snapshot", { headers: { origin } });
      expect(unauthorized.status).toBe(401);
      const snapshot = await harness.fetch("/api/v1/admin/snapshot", { headers: {
        origin, authorization: `Bearer ${harness.adminToken}`,
      } });
      expect(snapshot.status).toBe(200);
      expect(snapshot.headers.get("access-control-allow-origin")).toBe(origin);
      expect(snapshot.headers.get("vary")).toContain("Origin");
    }
    const origin = "http://tauri.localhost";
    const post = await harness.fetch("/api/v1/admin/outputs/pause", { method: "OPTIONS", headers: {
      origin, "access-control-request-method": "POST", "access-control-request-headers": "Authorization, Content-Type",
    } });
    expect(post.status).toBe(204);
    for (const other of ["https://evil.example", "http://tauri.localhost.evil.example", "null", "http://localhost:1420"]) {
      for (const method of ["GET", "OPTIONS"]) {
        const denied = await harness.fetch("/api/v1/admin/snapshot", { method, headers: {
          origin: other, authorization: `Bearer ${harness.adminToken}`, "access-control-request-method": "GET",
        } });
        expect(denied.status).toBe(403);
        expect(denied.headers.has("access-control-allow-origin")).toBe(false);
      }
    }
    for (const headers of [
      { origin, "access-control-request-method": "TRACE" },
      { origin, "access-control-request-method": "GET", "access-control-request-headers": "x-unapproved" },
    ]) {
      const denied = await harness.fetch("/api/v1/admin/snapshot", { method: "OPTIONS", headers });
      expect(denied.status).toBe(403);
    }
    const producer = await harness.fetch("/api/v1/producers/test/scopes/x/claims/status", {
      method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT" },
    });
    expect(producer.status).not.toBe(204);
    expect(producer.headers.has("access-control-allow-origin")).toBe(false);
    const abort = new AbortController();
    try {
      const sse = await harness.fetch("/api/v1/admin/events", { signal: abort.signal, headers: {
        origin, authorization: `Bearer ${harness.adminToken}`,
      } });
      expect(sse.status).toBe(200);
      expect(sse.headers.get("access-control-allow-origin")).toBe(origin);
      const reader = sse.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
      await reader.cancel();
    } finally { abort.abort(); }
  } finally { await harness.dispose(); }
});

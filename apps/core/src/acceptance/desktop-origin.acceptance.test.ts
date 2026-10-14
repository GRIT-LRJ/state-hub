import { expect, it } from "vitest";
import { CoreAcceptanceHarness } from "./harness.js";

it.each([false, true])("allows desktop transport without opening other origins (development=%s)", async (development) => {
  const devOrigin = "http://localhost:1420";
  const harness = await CoreAcceptanceHarness.start({ childEnvironment: {
    STATE_HUB_DESKTOP_DEV_ORIGIN: development ? devOrigin : "",
  } });
  try {
    for (const origin of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", ...(development ? [devOrigin] : [])]) {
      const preflight = await harness.fetch("/api/v1/admin/snapshot", { method: "OPTIONS", headers: {
        origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization",
      } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
      const unauthorized = await harness.fetch("/api/v1/admin/snapshot", { headers: { origin } });
      expect(unauthorized.status).toBe(401);
      const wrongToken = await harness.fetch("/api/v1/admin/snapshot", { headers: {
        origin, authorization: "Bearer incorrect",
      } });
      expect(wrongToken.status).toBe(401);
      const snapshot = await harness.fetch("/api/v1/admin/snapshot", { headers: {
        origin, authorization: `Bearer ${harness.adminToken}`,
      } });
      expect(snapshot.status).toBe(200);
      expect(snapshot.headers.get("access-control-allow-origin")).toBe(origin);
      expect(snapshot.headers.get("vary")).toContain("Origin");
    }
    const origin = development ? devOrigin : "http://tauri.localhost";
    const post = await harness.fetch("/api/v1/admin/outputs/pause", { method: "OPTIONS", headers: {
      origin, "access-control-request-method": "POST", "access-control-request-headers": "Authorization, Content-Type",
    } });
    expect(post.status).toBe(204);
    const paused = await harness.fetch("/api/v1/admin/outputs/pause", { method: "POST", headers: {
      origin, authorization: `Bearer ${harness.adminToken}`, "content-type": "application/json",
    }, body: JSON.stringify({ paused: true }) });
    expect(paused.status).toBe(200);
    const updated = await harness.fetch("/api/v1/admin/snapshot", { headers: {
      origin, authorization: `Bearer ${harness.adminToken}`,
    } });
    expect((await updated.json() as { outputsPaused: boolean }).outputsPaused).toBe(true);
    const config = { driverInstances: [
      { id: "virtual-main", driverType: "official.virtual", enabled: true, config: {} },
      { id: "dev-origin-output", driverType: "official.virtual", enabled: true, config: {} },
    ], bindings: [] };
    const draft = await harness.fetch("/api/v1/admin/config/drafts", { method: "POST", headers: {
      origin, authorization: `Bearer ${harness.adminToken}`, "content-type": "application/json",
    }, body: JSON.stringify(config) });
    expect(draft.status).toBe(201);
    const { revision } = await draft.json() as { revision: number };
    const published = await harness.fetch(`/api/v1/admin/config/drafts/${revision}/publish`, {
      method: "POST", headers: { origin, authorization: `Bearer ${harness.adminToken}` },
    });
    expect(published.status).toBe(200);
    const exported = await harness.fetch("/api/v1/admin/config/export", { headers: {
      origin, authorization: `Bearer ${harness.adminToken}`,
    } });
    expect((await exported.json() as { config: unknown }).config).toEqual(config);
    for (const other of ["https://evil.example", "http://tauri.localhost.evil.example", "null",
      "http://localhost:1421", "http://localhost.evil.example:1420", "http://127.0.0.1:1420",
      ...(!development ? [devOrigin] : [])]) {
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
      const resumed = await harness.fetch("/api/v1/admin/outputs/pause", { method: "POST", headers: {
        origin, authorization: `Bearer ${harness.adminToken}`, "content-type": "application/json",
      }, body: JSON.stringify({ paused: false }) });
      expect(resumed.status).toBe(200);
      let notices = "";
      while (!notices.includes("event: outputs.pause-changed")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        notices += new TextDecoder().decode(chunk.value);
      }
      await reader.cancel();
    } finally { abort.abort(); }
  } finally { await harness.dispose(); }
});

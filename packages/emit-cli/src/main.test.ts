import { expect, it } from "vitest";
import { parseCommand } from "./main.js";

it("creates a claim command for the versioned producer API", () => {
  const result = parseCommand(["claim", "codex", "session/1", "status", '{"value":{"phase":"decision"}}']);
  expect(result).not.toBe("drain");
  if (result !== "drain") {
    expect(result.path).toBe("/api/v1/producers/codex/scopes/session%2F1/claims/status");
    expect(result.method).toBe("PUT");
  }
});

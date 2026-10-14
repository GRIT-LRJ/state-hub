import assert from "node:assert/strict";
import { test } from "node:test";
import { unsignedConfig } from "./unsigned-config.mjs";

const base = { app: { windows: [{ label: "main", title: "State Hub", width: 1120 }] } };

test("unsigned alpha and beta cannot be confused with stable", () => {
  for (const channel of ["alpha", "beta"]) {
    const config = unsignedConfig(base, channel);
    assert.match(config.productName, /Unsigned/);
    assert.match(config.app.windows[0].title, /Unsigned/);
    assert.notEqual(config.identifier, "dev.statehub.desktop");
    assert.equal(config.plugins.updater.active, false);
    assert.equal(config.bundle.createUpdaterArtifacts, false);
  }
  assert.throws(() => unsignedConfig(base, "stable"));
});

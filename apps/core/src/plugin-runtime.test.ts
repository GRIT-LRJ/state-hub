import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateHubDatabase } from "./database.js";

describe("plugin package schema compatibility", () => {
  it("adds the enabled flag to databases created by the installation release", () => {
    const root = mkdtempSync(join(tmpdir(), "statehub-plugin-schema-test-"));
    const path = join(root, "old.db");
    try {
      const old = new Database(path);
      try {
        old.exec(`CREATE TABLE plugin_packages (
          id TEXT NOT NULL, version TEXT NOT NULL, publisher_id TEXT NOT NULL, signed INTEGER NOT NULL,
          manifest_json TEXT NOT NULL, source_definitions_json TEXT NOT NULL,
          driver_definitions_json TEXT NOT NULL, archive_sha256 TEXT NOT NULL,
          archive_blob BLOB NOT NULL, installed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (id, version)
        )`);
        old.prepare(`INSERT INTO plugin_packages(
          id, version, publisher_id, signed, manifest_json, source_definitions_json,
          driver_definitions_json, archive_sha256, archive_blob, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "legacy.plugin", "1.0.0", "legacy", 1, "{}", "[]", "[]", "hash", Buffer.from("archive"),
          "2026-01-01T00:00:00.000Z",
        );
      } finally { old.close(); }
      const current = new StateHubDatabase(path);
      try {
        const row = current.raw.prepare("SELECT enabled FROM plugin_packages WHERE id = 'legacy.plugin'")
          .get() as { enabled: number };
        expect(row.enabled).toBe(1);
      } finally { current.close(); }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

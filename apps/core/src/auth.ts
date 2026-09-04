import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StateHubDatabase } from "./database.js";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(hashToken(actual), "hex");
  const b = Buffer.from(hashToken(expected), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerProducer(
  db: StateHubDatabase,
  producerId: string,
  token: string,
  sourceDefinitionId?: string,
): void {
  db.raw
    .prepare(
      `INSERT INTO producer_tokens(producer_id, token_hash, source_definition_id, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(producer_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         source_definition_id = COALESCE(excluded.source_definition_id, producer_tokens.source_definition_id),
         revoked_at = NULL`,
    )
    .run(producerId, hashToken(token), sourceDefinitionId ?? null, new Date().toISOString());
}

export function authenticateProducer(db: StateHubDatabase, producerId: string, token: string): boolean {
  const row = db.raw
    .prepare("SELECT token_hash FROM producer_tokens WHERE producer_id = ? AND revoked_at IS NULL")
    .get(producerId) as { token_hash: string } | undefined;
  if (!row) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(row.token_hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

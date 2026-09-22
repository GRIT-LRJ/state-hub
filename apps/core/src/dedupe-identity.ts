import { createHash } from "node:crypto";

export function dedupeIdentityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

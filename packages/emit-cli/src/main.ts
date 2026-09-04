#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncEntry } from "@napi-rs/keyring";
import { cliPaths } from "./paths.js";

interface SpoolCommand {
  schemaVersion: 1;
  id: string;
  producerId: string;
  method: "PUT" | "POST";
  path: string;
  body?: unknown;
  createdAt: string;
}

function usage(): never {
  throw new Error(
    "Usage: state-hub-emit claim PRODUCER SCOPE SIGNAL JSON | clear PRODUCER SCOPE SIGNAL | event PRODUCER TYPE JSON [SCOPE] [EVENT_ID] | drain",
  );
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function parseCommand(args: string[]): SpoolCommand | "drain" {
  const [kind, producerId, first, second, third, fourth] = args;
  if (kind === "drain") return "drain";
  const id = kind === "event" && fourth ? fourth : randomUUID();
  const createdAt = new Date().toISOString();
  if (kind === "claim" && producerId && first && second && third) {
    return {
      schemaVersion: 1,
      id,
      producerId,
      method: "PUT",
      path: `/api/v1/producers/${encode(producerId)}/scopes/${encode(first)}/claims/${encode(second)}`,
      body: JSON.parse(third) as unknown,
      createdAt,
    };
  }
  if (kind === "clear" && producerId && first && second) {
    return {
      schemaVersion: 1,
      id,
      producerId,
      method: "POST",
      path: `/api/v1/producers/${encode(producerId)}/scopes/${encode(first)}/claims/${encode(second)}:clear`,
      createdAt,
    };
  }
  if (kind === "event" && producerId && first && second) {
    const body = JSON.parse(second) as Record<string, unknown>;
    return {
      schemaVersion: 1,
      id,
      producerId,
      method: "POST",
      path: `/api/v1/producers/${encode(producerId)}/events`,
      body: { ...body, eventId: id, type: first, ...(third ? { scopeId: third } : {}) },
      createdAt,
    };
  }
  return usage();
}

export function spool(command: SpoolCommand, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${command.createdAt.replaceAll(":", "-")}-${command.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(command)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows relies on the per-user application data ACL.
  }
  return target;
}

async function send(spoolPath: string, paths: ReturnType<typeof cliPaths>): Promise<boolean> {
  const command = JSON.parse(readFileSync(spoolPath, "utf8")) as SpoolCommand;
  const discovery = JSON.parse(readFileSync(paths.discovery, "utf8")) as { host: string; port: number };
  const token =
    process.env.STATE_HUB_PRODUCER_TOKEN ??
    (await new AsyncEntry("dev.statehub.desktop", `producer:${command.producerId}`).getPassword(AbortSignal.timeout(500)));
  if (!token) return false;
  const response = await fetch(`http://${discovery.host}:${discovery.port}${command.path}`, {
    method: command.method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": command.id,
    },
    ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    signal: AbortSignal.timeout(800),
  });
  if (response.status !== 202) return false;
  unlinkSync(spoolPath);
  return true;
}

export async function drain(paths: ReturnType<typeof cliPaths>, only?: string): Promise<void> {
  const { readdirSync } = await import("node:fs");
  mkdirSync(paths.spool, { recursive: true });
  const files = readdirSync(paths.spool)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(0, 100);
  for (const file of files) {
    const path = join(paths.spool, file);
    if (only && basename(path) !== basename(only)) continue;
    try {
      await send(path, paths);
    } catch {
      // Hooks are intentionally fail-open; the durable spool is retried later.
    }
  }
}

async function main(): Promise<void> {
  const paths = cliPaths();
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed === "drain") {
    await drain(paths);
    return;
  }
  await emitFailOpen(parsed, paths);
}

export async function emitFailOpen(command: SpoolCommand, paths = cliPaths()): Promise<void> {
  const path = spool(command, paths.spool);
  await drain(paths, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`state-hub-emit: ${error instanceof Error ? error.message : String(error)}\n`);
    // Codex and automation hooks must never be blocked by State Hub availability.
    process.exitCode = 0;
  });
}

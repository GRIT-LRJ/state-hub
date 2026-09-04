#!/usr/bin/env node
import { emitFailOpen, parseCommand } from "./main.js";

interface CodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  tool_name?: string;
  message?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function commandFor(payload: CodexHookPayload): ReturnType<typeof parseCommand> | undefined {
  const session = payload.session_id;
  if (!session || !payload.hook_event_name) return undefined;
  const event = payload.hook_event_name;
  if (event === "SessionEnd") return parseCommand(["clear", "codex", session, "status"]);
  if (event === "PostToolUse" && payload.tool_name === "request_user_input") {
    return parseCommand([
      "claim",
      "codex",
      session,
      "status",
      JSON.stringify({ value: { phase: "working", ...(payload.turn_id ? { turnId: payload.turn_id } : {}) }, urgency: "ambient" }),
    ]);
  }
  if (event === "UserPromptSubmit") {
    return parseCommand([
      "claim",
      "codex",
      session,
      "status",
      JSON.stringify({ value: { phase: "working", ...(payload.turn_id ? { turnId: payload.turn_id } : {}) }, urgency: "ambient" }),
    ]);
  }
  if (event === "PermissionRequest" || (event === "PreToolUse" && payload.tool_name === "request_user_input")) {
    return parseCommand([
      "claim",
      "codex",
      session,
      "status",
      JSON.stringify({
        value: { phase: "decision", ...(payload.turn_id ? { turnId: payload.turn_id } : {}), ...(payload.message ? { message: payload.message } : {}) },
        urgency: "action-required",
      }),
    ]);
  }
  if (event === "Stop") {
    return parseCommand([
      "claim",
      "codex",
      session,
      "status",
      JSON.stringify({
        value: { phase: "completed", ...(payload.turn_id ? { turnId: payload.turn_id } : {}) },
        urgency: "informational",
        expiresAt: new Date(Date.now() + 20_000).toISOString(),
        stalePolicy: "deactivate",
      }),
    ]);
  }
  return undefined;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const command = commandFor(JSON.parse(raw) as CodexHookPayload);
  if (command && command !== "drain") await emitFailOpen(command);
}

void main().catch((error) => {
  process.stderr.write(`state-hub-codex-hook: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 0;
});

import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export function cliPaths(env: NodeJS.ProcessEnv = process.env): {
  discovery: string;
  spool: string;
} {
  const data =
    env.STATE_HUB_DATA_DIR ??
    (platform() === "win32"
      ? join(env.LOCALAPPDATA ?? homedir(), "StateHub")
      : platform() === "darwin"
        ? join(homedir(), "Library", "Application Support", "StateHub")
        : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "state-hub"));
  const runtime =
    env.STATE_HUB_RUNTIME_DIR ??
    (platform() === "win32"
      ? join(env.LOCALAPPDATA ?? tmpdir(), "StateHub", "runtime")
      : join(env.XDG_RUNTIME_DIR ?? tmpdir(), `state-hub-${process.getuid?.() ?? "user"}`));
  return {
    discovery: join(runtime, "discovery.json"),
    spool: join(data, "spool"),
  };
}

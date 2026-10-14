import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function unsignedConfig(base, channel) {
  if (channel !== "alpha" && channel !== "beta") throw new Error("Unsigned stable package is forbidden");
  const label = `State Hub ${channel === "alpha" ? "Alpha" : "Beta"} (Unsigned)`;
  return {
    productName: label,
    identifier: `dev.statehub.desktop.${channel}`,
    app: { windows: base.app.windows.map((window) => ({ ...window, title: label })) },
    bundle: { createUpdaterArtifacts: false },
    plugins: { updater: { active: false, endpoints: [] } },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  const channel = process.argv[3] ?? "alpha";
  if (!output) throw new Error("Unsigned package output path required");
  const base = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(unsignedConfig(base, channel), null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Wrote clearly labelled ${channel} unsigned build config\n`);
}

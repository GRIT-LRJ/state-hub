import { registerHooks } from "node:module";

const fakeUrl = new URL("./fake-hid.mjs", import.meta.url).href;

// The acceptance Core imports this instead of the native HID library. It cannot reach hardware.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node-hid") return { url: fakeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const rename = fs.renameSync;
fs.renameSync = (...args) => {
  if (process.env.STATE_HUB_TEST_CRASH_POINT === "before-rename") process.exit(73);
  rename(...args);
  if (process.env.STATE_HUB_TEST_CRASH_POINT === "after-rename") process.exit(74);
};
syncBuiltinESMExports();

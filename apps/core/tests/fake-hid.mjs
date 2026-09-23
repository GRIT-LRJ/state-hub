import { appendFileSync, readFileSync } from "node:fs";

function fixture() {
  const path = process.env.STATE_HUB_FAKE_HID_FIXTURE;
  if (!path) throw new Error("Fake HID fixture path is missing");
  return JSON.parse(readFileSync(path, "utf8"));
}

export class HID {
  static devices() { return fixture().devices; }

  constructor(path) {
    if (fixture().failOpen) throw new Error("Fake HID open failure");
    this.path = path;
  }

  sendFeatureReport(data) {
    const state = fixture();
    appendFileSync(state.log, JSON.stringify({ path: this.path, data }) + "\n");
    return state.writeLength ?? data.length;
  }

  close() {}
}

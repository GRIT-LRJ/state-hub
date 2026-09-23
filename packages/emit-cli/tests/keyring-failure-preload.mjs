import { AsyncEntry } from "@napi-rs/keyring";

AsyncEntry.prototype.getPassword = async () => {
  throw new Error("Authorization: Bearer TEST_SECRET_MUST_NOT_APPEAR");
};

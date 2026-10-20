import type { SecureValueStore } from "../identity/secure-value-store";
import { getSecureValue, setSecureValue } from "./secure-store";

/** The real SecureStore behind the identity layer's `SecureValueStore` port. */
export const expoSecureValueStore: SecureValueStore = {
  get: getSecureValue,
  set: setSecureValue,
};

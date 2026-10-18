import * as SecureStore from "expo-secure-store";

/**
 * Thin, typed boundary over expo-secure-store. Infrastructure only for this
 * bootstrap (spec section 9) — reserved for future auth tokens and the
 * local DB encryption key. Do NOT use this for workout/training data.
 */
export async function getSecureValue(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function setSecureValue(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecureValue(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

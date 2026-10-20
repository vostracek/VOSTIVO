/**
 * Reads the `sub` claim of a JWT WITHOUT verifying it. Decoding locally is
 * NOT authorization: the result is only ever used as a lookup key into an
 * identity binding that a verified `GET /api/v1/me` created earlier
 * (AUTH-LOCAL-013). Returns `null` for anything that is not a JWT with a
 * non-empty string subject. Never logs the token.
 */
export function readUnverifiedJwtSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const json = atob(toBase64(payload));
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null) return null;
    const subject = (claims as { sub?: unknown }).sub;
    return typeof subject === "string" && subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

function toBase64(base64Url: string): string {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
}

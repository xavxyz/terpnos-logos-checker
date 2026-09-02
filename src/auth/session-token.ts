import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The token remembered in the browser. It is derived from the shared password
 * but cannot be turned back into it, so the password itself never leaves the
 * server — not in a bundle, not in a cookie, not in a response body.
 */
export function createSessionToken(sharedPassword: string): string {
  return createHmac("sha256", sharedPassword)
    .update("terpnos-logos-checker/session")
    .digest("hex");
}

export function isValidSessionToken(
  token: string | undefined,
  sharedPassword: string,
): boolean {
  if (!token) return false;

  return equalsInConstantTime(token, createSessionToken(sharedPassword));
}

export function isSharedPassword(
  candidate: string,
  sharedPassword: string,
): boolean {
  if (!candidate) return false;

  return equalsInConstantTime(candidate, sharedPassword);
}

function equalsInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on differing lengths, so compare digests of the
  // candidates rather than the candidates themselves: same length, always.
  return timingSafeEqual(digest(left), digest(right));
}

function digest(value: Buffer): Buffer {
  return createHmac("sha256", "comparison").update(value).digest();
}

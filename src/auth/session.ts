import { cookies } from "next/headers";

import { createSessionToken, isValidSessionToken } from "./session-token";

export const sessionCookieName = "terpnos-logos-session";

const oneYearInSeconds = 60 * 60 * 24 * 365;

/**
 * The single shared password, read on the server only. This module imports
 * `next/headers`, which Next refuses to bundle into a client component, so the
 * value cannot reach the browser by accident.
 */
export function sharedPassword(): string {
  const configured = process.env.SHARED_PASSWORD;

  if (!configured) {
    throw new Error(
      "SHARED_PASSWORD is not set: the application has no password to check against.",
    );
  }

  return configured;
}

export async function hasRememberedSession(): Promise<boolean> {
  const jar = await cookies();

  return isValidSessionToken(
    jar.get(sessionCookieName)?.value,
    sharedPassword(),
  );
}

export async function rememberSession(): Promise<void> {
  const jar = await cookies();

  jar.set(sessionCookieName, createSessionToken(sharedPassword()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: oneYearInSeconds,
  });
}

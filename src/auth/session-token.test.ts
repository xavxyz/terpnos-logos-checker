import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  isSharedPassword,
  isValidSessionToken,
} from "./session-token";

describe("the remembered session", () => {
  it("hands the browser a token that is not the password itself", () => {
    const token = createSessionToken("un-mot-de-passe");

    expect(token).not.toContain("un-mot-de-passe");
  });

  it("recognises a token it issued for the same password", () => {
    const token = createSessionToken("un-mot-de-passe");

    expect(isValidSessionToken(token, "un-mot-de-passe")).toBe(true);
  });

  it("rejects a token issued for another password", () => {
    const token = createSessionToken("un-autre-mot-de-passe");

    expect(isValidSessionToken(token, "un-mot-de-passe")).toBe(false);
  });

  it("rejects a forged token", () => {
    expect(isValidSessionToken("n-importe-quoi", "un-mot-de-passe")).toBe(
      false,
    );
  });

  it("rejects the absence of a token", () => {
    expect(isValidSessionToken(undefined, "un-mot-de-passe")).toBe(false);
    expect(isValidSessionToken("", "un-mot-de-passe")).toBe(false);
  });
});

describe("the password check", () => {
  it("accepts the shared password and nothing else", () => {
    expect(isSharedPassword("un-mot-de-passe", "un-mot-de-passe")).toBe(true);
    expect(isSharedPassword("un-mot-de-pass", "un-mot-de-passe")).toBe(false);
    expect(isSharedPassword("", "un-mot-de-passe")).toBe(false);
    expect(isSharedPassword("UN-MOT-DE-PASSE", "un-mot-de-passe")).toBe(false);
  });
});

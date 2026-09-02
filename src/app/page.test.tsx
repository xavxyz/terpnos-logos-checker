import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@/auth/session-token";
import { sessionCookieName } from "@/auth/session";

const sharedPassword = "le-mot-de-passe-partage";

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in cookieJar ? { name, value: cookieJar[name] } : undefined,
  }),
}));

beforeEach(() => {
  cookieJar = {};
  process.env.SHARED_PASSWORD = sharedPassword;
});

async function render(searchParams: Record<string, string> = {}) {
  const { default: Page } = await import("./page");

  return renderToStaticMarkup(
    await Page({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("visiting without a remembered session", () => {
  it("asks for the shared password, in French", async () => {
    const markup = await render();

    expect(markup).toContain("Mot de passe");
    expect(markup).toContain('type="password"');
  });

  it("does not show the submission screen", async () => {
    const markup = await render();

    expect(markup).not.toContain("<textarea");
  });

  it("never puts the password in the response", async () => {
    const markup = await render();

    expect(markup).not.toContain(sharedPassword);
  });

  it("shows a French error after a wrong password", async () => {
    const markup = await render({ erreur: "1" });

    expect(markup).toContain("Mot de passe incorrect");
  });

  it("stays silent until a password has actually been refused", async () => {
    const markup = await render();

    expect(markup).not.toContain("Mot de passe incorrect");
  });
});

describe("visiting with a remembered session", () => {
  beforeEach(() => {
    cookieJar[sessionCookieName] = createSessionToken(sharedPassword);
  });

  it("offers a textarea for the terpnos logos", async () => {
    const markup = await render();

    expect(markup).toContain("<textarea");
    expect(markup).toContain("Terpnos logos");
  });

  it("offers a drop zone accepting mp3, m4a and wav", async () => {
    const markup = await render();

    expect(markup).toMatch(/accept="[^"]*\.mp3[^"]*\.m4a[^"]*\.wav/);
    expect(markup).toContain('type="file"');
  });

  it("does not ask for the password again", async () => {
    const markup = await render();

    expect(markup).not.toContain('type="password"');
  });

  it("never puts the password in the response", async () => {
    const markup = await render();

    expect(markup).not.toContain(sharedPassword);
  });
});

describe("visiting with a token issued for another password", () => {
  it("asks for the password again", async () => {
    cookieJar[sessionCookieName] = createSessionToken("un-vieux-mot-de-passe");

    const markup = await render();

    expect(markup).toContain('type="password"');
  });
});

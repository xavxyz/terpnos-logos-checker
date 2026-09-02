import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedPassword = "le-mot-de-passe-partage";

const setCookie = vi.fn();
const redirect = vi.fn((destination: string) => {
  throw new Error(`NEXT_REDIRECT:${destination}`);
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: setCookie, get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => redirect(destination),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHARED_PASSWORD = sharedPassword;
});

async function submit(password: string) {
  const { unlock } = await import("./unlock");
  const form = new FormData();
  form.set("mot-de-passe", password);

  return unlock(form).catch((error: Error) => error.message);
}

describe("submitting the shared password", () => {
  it("remembers the session in the browser", async () => {
    await submit(sharedPassword);

    expect(setCookie).toHaveBeenCalledOnce();
    const [name, value, options] = setCookie.mock.calls[0];
    expect(name).toBe("terpnos-logos-session");
    expect(value).not.toContain(sharedPassword);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax" });
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it("lands on the submission screen", async () => {
    await submit(sharedPassword);

    expect(redirect).toHaveBeenCalledWith("/");
  });
});

describe("submitting a wrong password", () => {
  it("remembers nothing", async () => {
    await submit("pas-le-bon");

    expect(setCookie).not.toHaveBeenCalled();
  });

  it("comes back with an error to show", async () => {
    await submit("pas-le-bon");

    expect(redirect).toHaveBeenCalledWith("/?erreur=1");
  });

  it("treats an empty submission as a wrong password", async () => {
    await submit("");

    expect(setCookie).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/?erreur=1");
  });
});

describe("a deployment without a configured password", () => {
  it("refuses to let anyone in", async () => {
    delete process.env.SHARED_PASSWORD;

    const outcome = await submit("n-importe-quoi");

    expect(setCookie).not.toHaveBeenCalled();
    expect(outcome).not.toContain("NEXT_REDIRECT:/");
  });
});

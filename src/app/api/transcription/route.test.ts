import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionCookieName } from "@/auth/session";
import { createSessionToken } from "@/auth/session-token";
import { recordingsFolder } from "@/recording/blob-upload";

const sharedPassword = "le-mot-de-passe-partage";
const chemin = `${recordingsFolder}f3af4e3e-aa1a-4351-a8fb-7f4fcc5c2faf.mp3`;

/**
 * The URL a private blob has of its own. It answers 403 to the transcription
 * provider, which fetches the audio from its own servers with no token, so it
 * must never be what the provider is handed.
 */
const bareBlobUrl = `https://store.private.blob.vercel-storage.com/${chemin}`;
const presignedUrl = `${bareBlobUrl}?sig=une-signature`;

let cookieJar: Record<string, string> = {};
const start = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in cookieJar ? { name, value: cookieJar[name] } : undefined,
  }),
}));

vi.mock("@vercel/blob", () => ({
  head: async () => ({ url: bareBlobUrl }),
  issueSignedToken: async () => ({
    clientSigningToken: "un-jeton",
    delegationToken: "une-delegation",
  }),
  presignUrl: async () => ({ presignedUrl }),
  del: async () => undefined,
  list: async () => ({ blobs: [] }),
}));

vi.mock("@/transcription/provider", () => ({
  transcriptionProvider: () => ({ start, progress: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHARED_PASSWORD = sharedPassword;
  cookieJar = { [sessionCookieName]: createSessionToken(sharedPassword) };
  start.mockResolvedValue({ kind: "started", job: "un-travail" });
});

async function startTranscription() {
  const { POST } = await import("./route");

  return POST(
    new Request("https://exemple.test/api/transcription", {
      method: "POST",
      body: JSON.stringify({ chemin }),
    }),
  );
}

describe("handing a recording to the transcription provider", () => {
  it("hands it a signed link rather than the blob's own URL", async () => {
    await startTranscription();

    expect(start).toHaveBeenCalledWith(presignedUrl);
  });

  it("never hands it the bare URL, which a private store refuses", async () => {
    await startTranscription();

    expect(start).not.toHaveBeenCalledWith(bareBlobUrl);
  });
});

import type { SpokenWord } from "@/report/tokenise";

import type {
  StartedTranscription,
  TranscriptionFailure,
  TranscriptionProgress,
  TranscriptionProvider,
} from "./provider";

const transcriptEndpoint = "https://api.assemblyai.com/v2/transcript";

/**
 * AssemblyAI, chosen over OpenAI for two measured reasons: OpenAI caps a file
 * at 25 MB, which would force splitting a 40-minute session, and
 * `gpt-4o-transcribe` returns no word-level timestamps, which click-to-listen
 * needs.
 */
export function assemblyAi(): TranscriptionProvider {
  return { start, progress };
}

async function start(recordingUrl: string): Promise<StartedTranscription> {
  const key = apiKey();

  if (!key) return { kind: "failed", failure: notConfigured };

  let answer: Response;

  try {
    answer = await fetch(transcriptEndpoint, {
      method: "POST",
      headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({
        audio_url: recordingUrl,
        language_code: "fr",
        punctuate: true,
        format_text: true,
        // Hesitations are part of what the sophrologist wants to see, so they
        // are reported rather than hidden.
        disfluencies: true,
      }),
    });
  } catch {
    return { kind: "failed", failure: unreachable };
  }

  if (!answer.ok) {
    return { kind: "failed", failure: failureFromStatus(answer.status) };
  }

  const body = await readJson(answer);

  if (typeof body?.id !== "string") {
    return { kind: "failed", failure: unexpectedAnswer };
  }

  return { kind: "started", job: body.id };
}

async function progress(job: string): Promise<TranscriptionProgress> {
  const key = apiKey();

  if (!key) return { kind: "failed", failure: notConfigured };

  let answer: Response;

  try {
    answer = await fetch(`${transcriptEndpoint}/${encodeURIComponent(job)}`, {
      headers: { authorization: key },
      // Asking again must mean asking again: a cached answer would leave the
      // session stuck on "processing" for as long as the job takes.
      cache: "no-store",
    });
  } catch {
    return { kind: "failed", failure: unreachable };
  }

  if (!answer.ok) {
    return { kind: "failed", failure: failureFromStatus(answer.status) };
  }

  const body = await readJson(answer);

  switch (body?.status) {
    case "queued":
    case "processing":
      return { kind: "running" };

    case "completed":
      return { kind: "done", transcript: { words: spokenWords(body.words) } };

    case "error":
      return { kind: "failed", failure: recordingRefused };

    default:
      return { kind: "failed", failure: unexpectedAnswer };
  }
}

/**
 * The key lives in a Vercel environment variable and is read here, on the
 * server, one call at a time. It is never part of an answer to the browser.
 */
function apiKey(): string | null {
  return process.env.ASSEMBLYAI_API_KEY || null;
}

/** What AssemblyAI answers about one transcription. */
type AssemblyAiAnswer = {
  id?: unknown;
  status?: unknown;
  words?: unknown;
};

async function readJson(answer: Response): Promise<AssemblyAiAnswer | null> {
  try {
    return (await answer.json()) as AssemblyAiAnswer;
  } catch {
    return null;
  }
}

/**
 * Each word with the moment it was spoken, in milliseconds, which is what the
 * report needs to seek the player. A word without one cannot be clicked and is
 * of no use, so it is left out.
 */
function spokenWords(words: unknown): SpokenWord[] {
  if (!Array.isArray(words)) return [];

  return words.flatMap((word: unknown) => {
    const { text, start } = (word ?? {}) as { text?: unknown; start?: unknown };

    if (typeof text !== "string" || typeof start !== "number") return [];
    if (!Number.isFinite(start)) return [];

    return [{ text, start }];
  });
}

const notConfigured: TranscriptionFailure = {
  message:
    "La transcription n’est pas configurée sur le serveur. Prévenez le propriétaire.",
  suite: "prevenir",
};

const keyRefused: TranscriptionFailure = {
  message:
    "Le service de transcription a refusé la clé du propriétaire. Prévenez le propriétaire.",
  suite: "prevenir",
};

const outOfCredit: TranscriptionFailure = {
  message:
    "Le compte de transcription du propriétaire n’a plus de crédit. Prévenez le propriétaire.",
  suite: "prevenir",
};

const requestRefused: TranscriptionFailure = {
  message:
    "Le service de transcription a refusé la demande. Prévenez le propriétaire.",
  suite: "prevenir",
};

const saturated: TranscriptionFailure = {
  message:
    "Le service de transcription est saturé pour le moment. Attendez quelques minutes et réessayez.",
  suite: "reessayer",
};

const unavailable: TranscriptionFailure = {
  message:
    "Le service de transcription est momentanément indisponible. Réessayez dans quelques minutes.",
  suite: "reessayer",
};

const unreachable: TranscriptionFailure = {
  message:
    "Le service de transcription est injoignable. Réessayez dans quelques minutes.",
  suite: "reessayer",
};

const unexpectedAnswer: TranscriptionFailure = {
  message:
    "Le service de transcription a répondu de façon inattendue. Prévenez le propriétaire.",
  suite: "prevenir",
};

const recordingRefused: TranscriptionFailure = {
  message:
    "La transcription de l’enregistrement a échoué. Réessayez avec ce fichier ou avec une autre version de l’audio.",
  suite: "reessayer",
};

/**
 * A refusal the sophrologist can do nothing about — a key, a credit, a demand
 * the service does not accept — sends her to the owner; anything that can pass
 * on its own sends her back to the button.
 */
function failureFromStatus(status: number): TranscriptionFailure {
  if (status === 401 || status === 403) return keyRefused;
  if (status === 402) return outOfCredit;
  if (status === 429) return saturated;
  if (status >= 500) return unavailable;

  return requestRefused;
}

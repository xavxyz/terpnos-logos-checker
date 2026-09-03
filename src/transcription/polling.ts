import type { Transcript } from "@/report/build-report";

import type { TranscriptionFailure } from "./provider";

/** Where the browser starts a transcription and asks how it is going. */
export const transcriptionRoute = "/api/transcription";

/**
 * How often the browser asks. Short enough that a finished transcript is picked
 * up almost at once, long enough that a three-minute session is a few dozen
 * questions and not a flood.
 */
export const pollingIntervalInMilliseconds = 3000;

/** A transcription that never lands must not leave the sophrologist waiting. */
export const pollingTimeLimitInMilliseconds = 15 * 60 * 1000;

/** How many unanswered questions in a row before the wait is called off. */
const toleratedSilentAnswers = 5;

const jobReferencePattern = /^[A-Za-z0-9_-]{1,128}$/;

/** The reference the provider gave, as it comes back from the browser. */
export function isJobReference(job: string): boolean {
  return jobReferencePattern.test(job);
}

/** What the browser sends to start the transcription of one recording. */
export type StartTranscriptionRequest = { chemin: string };

/** What the route answers once the provider has taken the recording. */
export type StartedTranscriptionResponse = { job: string };

/** What the route answers while the transcription runs, and when it is in. */
export type TranscriptionProgressResponse =
  | { etat: "en-cours" }
  | { etat: "terminee"; transcript: Transcript; avertissement?: string };

/** What the route answers when the transcription cannot go on. */
export type TranscriptionFailureResponse = {
  erreur: string;
  suite: TranscriptionFailure["suite"];
};

/** The end of the wait, as the submission screen sees it. */
export type TranscriptionResult =
  | { kind: "done"; transcript: Transcript; avertissement?: string }
  | { kind: "failed"; failure: TranscriptionFailure };

/**
 * The whole wait, from the browser's side: the server starts the job and hands
 * back a reference, and the browser asks this route — never the provider — how
 * it is going until the transcript is in. The API key stays on the server, and
 * nothing the browser holds can be spent on the owner's account.
 */
export async function transcribeRecording(
  chemin: string,
): Promise<TranscriptionResult> {
  const started = await startTranscription(chemin);

  if (started.kind === "failed") return started;

  const until = Date.now() + pollingTimeLimitInMilliseconds;
  let silentAnswers = 0;

  while (Date.now() < until) {
    await pause(pollingIntervalInMilliseconds);

    const answer = await askProgress(started.job, chemin);

    if (answer.kind === "silent") {
      // A question lost on the way is not a failed transcription: the job is
      // running on the provider's side either way, so ask again.
      silentAnswers += 1;
      if (silentAnswers < toleratedSilentAnswers) continue;
      return { kind: "failed", failure: serverUnreachable };
    }

    silentAnswers = 0;
    if (answer.kind !== "running") return answer;
  }

  return { kind: "failed", failure: tookTooLong };
}

async function startTranscription(chemin: string): Promise<StartedOrFailed> {
  let answer: Response;

  try {
    answer = await fetch(transcriptionRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chemin } satisfies StartTranscriptionRequest),
    });
  } catch {
    return { kind: "failed", failure: serverUnreachable };
  }

  const body = await readJson(answer);

  if (!answer.ok) return { kind: "failed", failure: failureFrom(body) };

  const job = (body as Partial<StartedTranscriptionResponse> | null)?.job;

  if (typeof job !== "string") {
    return { kind: "failed", failure: unexpectedAnswer };
  }

  return { kind: "started", job };
}

type StartedOrFailed =
  | { kind: "started"; job: string }
  | { kind: "failed"; failure: TranscriptionFailure };

type ProgressAnswer =
  { kind: "running" } | { kind: "silent" } | TranscriptionResult;

async function askProgress(
  job: string,
  chemin: string,
): Promise<ProgressAnswer> {
  const question = `${transcriptionRoute}?job=${encodeURIComponent(job)}&chemin=${encodeURIComponent(chemin)}`;

  let answer: Response;

  try {
    answer = await fetch(question, { cache: "no-store" });
  } catch {
    return { kind: "silent" };
  }

  const body = await readJson(answer);

  if (!answer.ok) return { kind: "failed", failure: failureFrom(body) };

  const progress = body as Partial<TranscriptionProgressResponse> | null;

  if (progress?.etat === "en-cours") return { kind: "running" };

  if (
    progress?.etat === "terminee" &&
    Array.isArray(progress.transcript?.words)
  ) {
    return {
      kind: "done",
      transcript: progress.transcript,
      avertissement: progress.avertissement,
    };
  }

  return { kind: "failed", failure: unexpectedAnswer };
}

async function readJson(answer: Response): Promise<unknown> {
  try {
    return await answer.json();
  } catch {
    return null;
  }
}

/** The route says why it stopped, in French; anything else is a surprise. */
function failureFrom(body: unknown): TranscriptionFailure {
  const said = body as Partial<TranscriptionFailureResponse> | null;

  if (typeof said?.erreur !== "string") return unexpectedAnswer;

  return {
    message: said.erreur,
    suite: said.suite === "prevenir" ? "prevenir" : "reessayer",
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

const serverUnreachable: TranscriptionFailure = {
  message:
    "La transcription ne répond plus. Vérifiez votre connexion et réessayez.",
  suite: "reessayer",
};

const tookTooLong: TranscriptionFailure = {
  message:
    "La transcription n’a pas abouti dans le temps imparti. Réessayez la séance.",
  suite: "reessayer",
};

const unexpectedAnswer: TranscriptionFailure = {
  message:
    "La transcription a répondu de façon inattendue. Prévenez le propriétaire.",
  suite: "prevenir",
};

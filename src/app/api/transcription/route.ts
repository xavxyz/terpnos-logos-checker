import { head } from "@vercel/blob";
import { NextResponse } from "next/server";

import { hasRememberedSession } from "@/auth/session";
import { deleteRecording } from "@/recording/blob-store";
import { isRecordingPathname } from "@/recording/blob-upload";
import {
  isJobReference,
  type StartedTranscriptionResponse,
  type TranscriptionFailureResponse,
  type TranscriptionProgressResponse,
} from "@/transcription/polling";
import {
  transcriptionProvider,
  type TranscriptionFailure,
} from "@/transcription/provider";

/**
 * Starts the transcription of the recording that has just landed in the store,
 * and answers with the reference the browser will poll with. A Vercel function
 * cannot stay alive for the one to three minutes a session takes, so this one
 * hands the job over and returns.
 *
 * The browser names the recording by pathname and the server resolves the URL
 * itself, so nothing the browser sends can point the owner's transcription
 * account at a file of its choosing.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!(await hasRememberedSession())) return sessionExpired();

  const { chemin } = (await request.json().catch(() => ({}))) as {
    chemin?: unknown;
  };

  if (typeof chemin !== "string" || !isRecordingPathname(chemin)) {
    return refusal(noRecording, 400);
  }

  let recordingUrl: string;

  try {
    ({ url: recordingUrl } = await head(chemin));
  } catch {
    return refusal(recordingLost, 502);
  }

  const started = await transcriptionProvider().start(recordingUrl);

  if (started.kind === "failed") {
    // Nothing will read the recording now, and Vercel Blob bills a blob for as
    // long as it exists: a failure leaves nothing behind either.
    await forget(chemin);
    return refusal(started.failure, 502);
  }

  return NextResponse.json({
    job: started.job,
  } satisfies StartedTranscriptionResponse);
}

/**
 * Where the browser asks how the transcription is going. The provider is
 * reached from here, with the owner's key, which therefore never travels to the
 * browser nor appears in any answer.
 *
 * As soon as the transcript is in — or as soon as the transcription has
 * definitively failed — the recording is deleted from the store, in the very
 * request that learns it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!(await hasRememberedSession())) return sessionExpired();

  const asked = new URL(request.url).searchParams;
  const job = asked.get("job");
  const chemin = asked.get("chemin");

  if (!job || !isJobReference(job)) return refusal(noJob, 400);
  if (!chemin || !isRecordingPathname(chemin)) return refusal(noRecording, 400);

  const progress = await transcriptionProvider().progress(job);

  if (progress.kind === "running") {
    return NextResponse.json({
      etat: "en-cours",
    } satisfies TranscriptionProgressResponse);
  }

  const freed = await forget(chemin);

  if (progress.kind === "failed") return refusal(progress.failure, 502);

  return NextResponse.json({
    etat: "terminee",
    transcript: progress.transcript,
    ...(freed
      ? {}
      : {
          avertissement:
            "L’enregistrement n’a pas pu être supprimé du stockage. Prévenez le propriétaire.",
        }),
  } satisfies TranscriptionProgressResponse);
}

/**
 * The recording has served its purpose. A deletion that fails is not worth
 * losing the transcript over — the sophrologist is told instead, and the next
 * upload sweeps what is left.
 */
async function forget(chemin: string): Promise<boolean> {
  try {
    await deleteRecording(chemin);
    return true;
  } catch {
    return false;
  }
}

function refusal(
  failure: TranscriptionFailure,
  status: number,
): NextResponse<TranscriptionFailureResponse> {
  return NextResponse.json(
    { erreur: failure.message, suite: failure.suite },
    { status },
  );
}

function sessionExpired(): NextResponse<TranscriptionFailureResponse> {
  return refusal(
    {
      message: "Session expirée : entrez à nouveau le mot de passe.",
      suite: "reessayer",
    },
    401,
  );
}

const noRecording: TranscriptionFailure = {
  message: "Aucun enregistrement à transcrire. Réessayez l’envoi de la séance.",
  suite: "reessayer",
};

const noJob: TranscriptionFailure = {
  message: "Aucune transcription à suivre. Réessayez l’envoi de la séance.",
  suite: "reessayer",
};

const recordingLost: TranscriptionFailure = {
  message:
    "L’enregistrement est introuvable dans le stockage. Réessayez l’envoi de la séance.",
  suite: "reessayer",
};

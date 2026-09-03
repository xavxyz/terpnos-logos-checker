import type { Transcript } from "@/report/build-report";

import { assemblyAi } from "./assemblyai";

/**
 * Why a transcription failed, and what the sophrologist is to do about it:
 * `reessayer` when sending the session again can work, `prevenir` when only the
 * owner can unblock it. The message is French and is shown as written.
 */
export type TranscriptionFailure = {
  message: string;
  suite: "reessayer" | "prevenir";
};

/** A transcription that is now running at the provider, or one that never was. */
export type StartedTranscription =
  | { kind: "started"; job: string }
  | { kind: "failed"; failure: TranscriptionFailure };

/** Where a running transcription stands. */
export type TranscriptionProgress =
  | { kind: "running" }
  | { kind: "done"; transcript: Transcript }
  | { kind: "failed"; failure: TranscriptionFailure };

/**
 * The single boundary between this application and a transcription provider.
 * Everything above it — the route, the polling, the progress steps — knows only
 * these three shapes and never which provider answers, so the provider can be
 * swapped without touching any of them. Only one ships.
 */
export type TranscriptionProvider = {
  /**
   * Hands the recording to the provider and returns the reference the browser
   * will poll with. A Vercel function cannot stay alive for the one to three
   * minutes a session takes, so nothing here waits for the transcript.
   */
  start(recordingUrl: string): Promise<StartedTranscription>;
  progress(job: string): Promise<TranscriptionProgress>;
};

export function transcriptionProvider(): TranscriptionProvider {
  return assemblyAi();
}

import { NextResponse } from "next/server";

import { hasRememberedSession } from "@/auth/session";
import { deleteRecording } from "@/recording/blob-store";
import { isRecordingPathname } from "@/recording/blob-upload";

/**
 * The browser tells the server the flow is over — because it finished, because
 * it failed, or because the page is going away — and the server deletes the
 * recording. No blob outlives the flow.
 *
 * The deletion is asked for by pathname rather than by URL: the pathname is
 * known before the first byte is sent, so an upload that never finished can be
 * cleaned up just as well as one that did.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!(await hasRememberedSession())) {
    return NextResponse.json(
      { erreur: "Session expirée : entrez à nouveau le mot de passe." },
      { status: 401 },
    );
  }

  const { chemin } = (await request.json()) as { chemin?: unknown };

  if (typeof chemin !== "string" || !isRecordingPathname(chemin)) {
    return NextResponse.json(
      { erreur: "Aucun enregistrement à supprimer." },
      { status: 400 },
    );
  }

  try {
    await deleteRecording(chemin);
  } catch {
    return NextResponse.json(
      { erreur: "L’enregistrement n’a pas pu être supprimé du stockage." },
      { status: 502 },
    );
  }

  return new NextResponse(null, { status: 204 });
}

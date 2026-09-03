"use client";

import { upload } from "@vercel/blob/client";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";

import {
  acceptedRecordingFormats,
  isAcceptedRecording,
  recordingContentType,
  recordingFormat,
} from "@/recording/accepted-formats";
import {
  recordingDeletionRoute,
  recordingPathname,
  uploadTokenRoute,
} from "@/recording/blob-upload";

type Etape = "attente" | "envoi" | "liberation" | "termine";

export function SubmissionForm() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState<File | null>(null);
  const [refus, setRefus] = useState<string | null>(null);
  const [survole, setSurvole] = useState(false);
  const [etape, setEtape] = useState<Etape>("attente");
  const [progression, setProgression] = useState(0);

  // The recording currently in the store, if any. Held in a ref so the page can
  // still name it when it is unloaded in the middle of an upload.
  const chemin = useRef<string | null>(null);

  useEffect(() => {
    function libererEnPartant() {
      const enCours = chemin.current;

      if (!enCours) return;

      chemin.current = null;
      // The page is going away: a normal request would be cancelled with it, so
      // the deletion is handed to the browser to send on its own. An abandoned
      // flow must not leave a paid blob behind either.
      navigator.sendBeacon(
        recordingDeletionRoute,
        new Blob([JSON.stringify({ chemin: enCours })], {
          type: "application/json",
        }),
      );
    }

    window.addEventListener("pagehide", libererEnPartant);

    return () => window.removeEventListener("pagehide", libererEnPartant);
  }, []);

  function accepter(file: File | undefined) {
    if (!file) return;

    if (!isAcceptedRecording(file)) {
      setRecording(null);
      setRefus(
        `Format non pris en charge : seuls les fichiers ${acceptedRecordingFormats.join(", ")} sont acceptés.`,
      );
      return;
    }

    setRefus(null);
    setEtape("attente");
    setProgression(0);
    setRecording(file);
  }

  function deposer(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setSurvole(false);
    accepter(event.dataTransfer.files[0]);
  }

  async function supprimer(enCours: string): Promise<boolean> {
    const reponse = await fetch(recordingDeletionRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chemin: enCours }),
    });

    // Only once the server has actually deleted it does the page stop holding
    // the recording: until then, leaving the page must still ask for it to go.
    if (reponse.ok) chemin.current = null;

    return reponse.ok;
  }

  async function envoyer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (etape === "envoi" || etape === "liberation") return;

    if (!recording) {
      setRefus("Déposez d’abord l’enregistrement de la séance.");
      return;
    }

    const format = recordingFormat(recording.name);

    if (!format) {
      setRefus(
        `Format non pris en charge : seuls les fichiers ${acceptedRecordingFormats.join(", ")} sont acceptés.`,
      );
      return;
    }

    const destination = recordingPathname(format);

    chemin.current = destination;
    setRefus(null);
    setProgression(0);
    setEtape("envoi");

    try {
      // Straight from the browser to Vercel Blob, in one piece, whatever the
      // length of the session: the file never enters a function body.
      await upload(destination, recording, {
        access: "public",
        contentType: recordingContentType(format),
        handleUploadUrl: uploadTokenRoute,
        // The recording is neither split nor transcoded: it is sent whole, and
        // arrives as one blob. Multipart is transport only — the browser sends
        // the bytes in parallel chunks so a 40-minute file survives a long
        // upload — and the sophrologist never touches a piece of it.
        multipart: true,
        onUploadProgress: ({ percentage }) =>
          setProgression(Math.round(percentage)),
      });
    } catch {
      // A failed upload can still have left parts behind, and a paid blob must
      // not survive a failure.
      await supprimer(destination).catch(() => false);
      setEtape("attente");
      setRefus(
        "L’envoi de l’enregistrement a échoué. Vérifiez votre connexion et réessayez.",
      );
      return;
    }

    // The end of the flow, for now: nothing else uses the recording yet, so the
    // server deletes it immediately rather than let it accrue storage cost.
    setEtape("liberation");

    if (!(await supprimer(destination).catch(() => false))) {
      setEtape("attente");
      setRefus(
        "L’enregistrement a été envoyé mais n’a pas pu être supprimé du stockage. Prévenez le propriétaire.",
      );
      return;
    }

    setEtape("termine");
  }

  const enCours = etape === "envoi" || etape === "liberation";

  return (
    <main className="ecran">
      <h1>Vérificateur de terpnos logos</h1>
      <form className="pile" onSubmit={envoyer}>
        <label className="champ" htmlFor="terpnos-logos">
          Terpnos logos
        </label>
        <textarea
          id="terpnos-logos"
          name="terpnos-logos"
          rows={18}
          placeholder="Collez ici le terpnos logos de la séance."
        />

        <span className="champ" id="etiquette-enregistrement">
          Enregistrement de la séance
        </span>
        <div
          className={survole ? "depot depot--survole" : "depot"}
          role="button"
          tabIndex={0}
          aria-describedby="etiquette-enregistrement"
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInput.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setSurvole(true);
          }}
          onDragLeave={() => setSurvole(false)}
          onDrop={deposer}
        >
          <p>
            {recording
              ? recording.name
              : "Déposez le fichier audio ici, ou cliquez pour le choisir."}
          </p>
          <p className="discret">
            Formats acceptés : {acceptedRecordingFormats.join(", ")}
          </p>
          <input
            ref={fileInput}
            id="enregistrement"
            name="enregistrement"
            type="file"
            className="invisible"
            accept={acceptedRecordingFormats.join(",")}
            onChange={(event) => accepter(event.target.files?.[0])}
          />
        </div>
        {refus ? (
          <p className="erreur" role="alert">
            {refus}
          </p>
        ) : null}

        <button type="submit" disabled={enCours}>
          Comparer
        </button>

        {etape === "envoi" ? (
          <div className="progres">
            <p role="status">Envoi de l’enregistrement… {progression} %</p>
            <progress max={100} value={progression} />
          </div>
        ) : null}

        {etape === "liberation" ? (
          <p className="discret" role="status">
            Envoi terminé. Suppression de l’enregistrement du stockage…
          </p>
        ) : null}

        {etape === "termine" ? (
          <>
            <p role="status">
              Envoi terminé. L’enregistrement a été supprimé du stockage.
            </p>
            <p className="discret">La comparaison n’est pas encore branchée.</p>
          </>
        ) : null}
      </form>
    </main>
  );
}

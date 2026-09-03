"use client";

import { upload } from "@vercel/blob/client";
import {
  useCallback,
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
import { buildReport } from "@/report/build-report";
import { transcribeRecording } from "@/transcription/polling";

/**
 * The named steps of the wait, in order. Two minutes pass between dropping the
 * recording and reading the report, and the sophrologist must never wonder
 * whether the application has frozen: she is told which step she is on.
 */
const etapes = [
  { cle: "envoi", nom: "Envoi" },
  { cle: "transcription", nom: "Transcription" },
  { cle: "comparaison", nom: "Comparaison" },
] as const;

type Etape = (typeof etapes)[number]["cle"];

/** Where the session stands: before the first step, on one, or past the last. */
type Avancement = "attente" | Etape | "rapport";

const etatDeLEtape = {
  faite: "terminée",
  "en-cours": "en cours",
  "a-venir": "à venir",
} as const;

export function SubmissionForm() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState<File | null>(null);
  const [refus, setRefus] = useState<string | null>(null);
  const [avertissement, setAvertissement] = useState<string | null>(null);
  const [survole, setSurvole] = useState(false);
  const [avancement, setAvancement] = useState<Avancement>("attente");
  const [progression, setProgression] = useState(0);
  const [motsReconnus, setMotsReconnus] = useState(0);
  /** The report, exactly as the comparison seam returned it. */
  const [rapport, setRapport] = useState<string | null>(null);

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
    setAvertissement(null);
    setAvancement("attente");
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

    // One session at a time: a second submission while this one is still
    // working would upload over it and land its report on the wrong flow.
    if (avancement !== "attente" && avancement !== "rapport") return;

    // The terpnos logos is read here and stays here: it is never sent to a
    // server, because the comparison runs in the browser.
    const terpnosLogos = String(
      new FormData(event.currentTarget).get("terpnos-logos") ?? "",
    );

    if (!terpnosLogos.trim()) {
      setRefus("Collez d’abord le terpnos logos de la séance.");
      return;
    }

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
    setAvertissement(null);
    setRapport(null);
    setProgression(0);
    setAvancement("envoi");

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
      setAvancement("attente");
      setRefus(
        "L’envoi de l’enregistrement a échoué. Vérifiez votre connexion et réessayez.",
      );
      return;
    }

    setAvancement("transcription");

    // The server starts the job and answers with its reference; the browser
    // asks that same route how it is going until the transcript is in. The
    // provider is never called from here, so the owner's key stays server-side.
    const transcription = await transcribeRecording(destination);

    if (transcription.kind === "failed") {
      // The server deletes the recording as soon as a transcription has
      // definitively failed; this covers the failures it never saw.
      await supprimer(destination).catch(() => false);
      setAvancement("attente");
      setRefus(transcription.failure.message);
      return;
    }

    // The recording is gone: the server deleted it in the very request that
    // brought the transcript back. If it could not, the page keeps holding it
    // so that leaving asks for it again.
    if (!transcription.avertissement) chemin.current = null;

    setMotsReconnus(transcription.transcript.words.length);
    setAvertissement(transcription.avertissement ?? null);
    setAvancement("comparaison");

    // The comparison is fast, but it is a named step: the browser is given the
    // chance to paint it before the work starts, so it is seen rather than
    // skipped over.
    await new Promise((peint) => setTimeout(peint, 0));

    let compare: string;

    try {
      // The one seam of the application, run here on the real transcript. What
      // it returns is the report: the page shows it and reshapes nothing.
      compare = buildReport({
        script: terpnosLogos,
        transcript: transcription.transcript,
      });
    } catch {
      setAvancement("attente");
      setRefus(
        "La comparaison du terpnos logos et de l’enregistrement a échoué. Réessayez la séance.",
      );
      return;
    }

    setRapport(compare);
    setAvancement("rapport");
  }

  const enCours = avancement !== "attente" && avancement !== "rapport";

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

        {avancement === "attente" ? null : (
          <div className="progres">
            <ListeEtapes courante={avancement} />

            {avancement === "envoi" ? (
              <>
                <p role="status">Envoi de l’enregistrement… {progression} %</p>
                <progress max={100} value={progression} />
              </>
            ) : null}

            {avancement === "transcription" ? (
              <p role="status">
                Transcription de l’enregistrement… Comptez une à trois minutes
                pour une séance.
              </p>
            ) : null}

            {avancement === "comparaison" ? (
              <p role="status">
                Comparaison du terpnos logos et de l’enregistrement…
              </p>
            ) : null}

            {avancement === "rapport" ? (
              <p role="status">
                Transcription terminée : {motsReconnus.toLocaleString("fr-FR")}{" "}
                mots reconnus. L’enregistrement a été supprimé du stockage.
              </p>
            ) : null}

            {avertissement ? (
              <p className="erreur" role="alert">
                {avertissement}
              </p>
            ) : null}
          </div>
        )}
      </form>

      {rapport ? <Rapport rapport={rapport} /> : null}
    </main>
  );
}

/** The three named steps, and where the session stands among them. */
function ListeEtapes({
  courante,
}: {
  courante: Exclude<Avancement, "attente">;
}) {
  // Past the last step every step is behind her, and the report is on screen.
  const rangCourant =
    courante === "rapport"
      ? etapes.length
      : etapes.findIndex((etape) => etape.cle === courante);

  return (
    <ol className="etapes" role="status">
      {etapes.map((etape, rang) => {
        const etat =
          rang < rangCourant
            ? "faite"
            : rang === rangCourant
              ? "en-cours"
              : "a-venir";

        return (
          <li
            key={etape.cle}
            className={`etape etape--${etat}`}
            aria-current={etat === "en-cours" ? "step" : undefined}
          >
            <span className="etape__nom">{etape.nom}</span>
            <span className="etape__etat">{etatDeLEtape[etat]}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The report, in the page. It is a self-contained document with its own styles,
 * so it is shown as the document it is and nothing about it is recomputed or
 * reshaped here: the frame receives the very string the comparison returned.
 *
 * Scripts are refused inside it, and it is sized to its own content so the
 * sophrologist scrolls the page rather than a box within it.
 */
function Rapport({ rapport }: { rapport: string }) {
  const cadre = useRef<HTMLIFrameElement>(null);
  const [hauteur, setHauteur] = useState<number>();

  const mesurer = useCallback(() => {
    // The body of the report is as tall as the terpnos logos it holds, and no
    // taller: measuring it cannot chase the height it is being given.
    const corps = cadre.current?.contentDocument?.body;

    if (corps) setHauteur(corps.scrollHeight);
  }, []);

  useEffect(() => {
    const iframe = cadre.current;

    if (!iframe) return;

    // A narrower page reflows the report and changes its height.
    const observateur = new ResizeObserver(mesurer);
    observateur.observe(iframe);

    return () => observateur.disconnect();
  }, [mesurer]);

  return (
    <section className="rapport" aria-labelledby="titre-rapport">
      <h2 id="titre-rapport">Rapport de la séance</h2>
      <p className="discret">
        Votre terpnos logos tel que vous l’avez écrit. En rouge gras, ce que
        vous avez dit sans l’avoir écrit ; en rouge gras barré, ce que vous avez
        écrit sans le dire ; en gris italique, ce qui n’était pas à lire.
      </p>
      <iframe
        ref={cadre}
        className="rapport__cadre"
        title="Rapport de la séance"
        sandbox="allow-same-origin"
        srcDoc={rapport}
        style={hauteur ? { height: `${hauteur}px` } : undefined}
        onLoad={mesurer}
      />
    </section>
  );
}

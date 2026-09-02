"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";

import {
  acceptedRecordingFormats,
  isAcceptedRecording,
} from "@/recording/accepted-formats";

export function SubmissionForm() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState<File | null>(null);
  const [refus, setRefus] = useState<string | null>(null);
  const [survole, setSurvole] = useState(false);
  const [placeholder, setPlaceholder] = useState(false);

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
    setRecording(file);
  }

  function deposer(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setSurvole(false);
    accepter(event.dataTransfer.files[0]);
  }

  function envoyer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPlaceholder(true);
  }

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

        <button type="submit">Comparer</button>
        {placeholder ? (
          <p className="discret" role="status">
            La comparaison n’est pas encore branchée.
          </p>
        ) : null}
      </form>
    </main>
  );
}

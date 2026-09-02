import { unlock } from "./unlock";

export function UnlockForm({ refused }: { refused: boolean }) {
  return (
    <main className="ecran ecran--etroit">
      <h1>Vérificateur de terpnos logos</h1>
      <form action={unlock} className="pile">
        <label className="champ" htmlFor="mot-de-passe">
          Mot de passe
        </label>
        <input
          id="mot-de-passe"
          name="mot-de-passe"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
        />
        {refused ? (
          <p className="erreur" role="alert">
            Mot de passe incorrect.
          </p>
        ) : null}
        <button type="submit">Entrer</button>
      </form>
    </main>
  );
}

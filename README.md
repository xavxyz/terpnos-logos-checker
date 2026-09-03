# Terpnos logos checker

Comparateur de transcript audio vis-à-vis d'un _terpnos logos_ scripté d'une séance de sophrologie.

A sophrologist writes the complete text she will read aloud — the **terpnos logos** — then records the session. This application tells her where the recording and the text disagree: the words she improvised, the passage she skipped, the hesitation she voiced. It produces a **report**: the terpnos logos as she wrote it, with every difference marked inside it, ready to be copied out and become the next version of the text.

It does not score the reading. There is no fidelity percentage and no grade; the tool informs, it does not judge. The vocabulary the code, the issues and this README use is fixed in [`CONTEXT.md`](CONTEXT.md) — read it before changing anything.

The interface is in French. There is one user, one shared password, and no accounts.

## Using it

1. **Unlock.** One shared password, typed once; the session is remembered.
2. **Paste the terpnos logos.** Anything between square brackets `[…]` is non-spoken content — production headers, section titles, working abbreviations. It stays visible in the report but takes no part in the comparison, so it can never be reported as a passage you skipped.
3. **Drop the recording.** Any of the accepted audio formats. It goes straight from the browser to a Vercel Blob store with a single-use token; it never passes through the application server.
4. **Wait, by named step.** _Envoi_, then _Transcription_, then _Comparaison_. Twenty to forty minutes of audio take about two minutes, and you are always told which step you are on.
5. **Read the report.** Additions and omissions are marked in place. Click a difference to hear it: the pinned player seeks to that moment in the file you dropped.
6. **Take it away.** Copy the report with its colours intact — it survives a paste into Google Docs or Notion — or download it as a self-contained HTML file to keep beside the session.

The recording is deleted from the store as soon as the transcript comes back — and also if you close the tab mid-flow. The terpnos logos itself never leaves the browser: the comparison runs client-side.

## Running it locally

```bash
npm install
cp .env.example .env   # then fill it in — the file documents every variable
npm run dev            # http://localhost:3000
```

You need a `SHARED_PASSWORD` of your choosing, an [AssemblyAI](https://www.assemblyai.com/app/account) key, and a Vercel Blob store (`vercel env pull` writes `BLOB_READ_WRITE_TOKEN` once one is linked to the project). All three are server-only; the browser sees none of them.

The gates, which must all be green:

```bash
npm run typecheck
npm test
npm run build
npm run lint
npm run format:check
```

Deployment target is Vercel: `next build`, with the same three secrets set as project environment variables.

## Also: a Sandcastle experiment

This repository is as much a development experiment as a product. Almost all of the application code was written by autonomous [Claude Code](https://claude.com/claude-code) agents running in Vercel Sandbox microVMs, orchestrated by [Sandcastle](https://github.com/ai-hero-dev/sandcastle) from [`.sandcastle/`](.sandcastle/README.md).

The shape of the experiment: every unit of work is a GitHub issue with explicit acceptance criteria; the orchestrator reads the issue, starts a sandbox, hands the agent the repository and the issue, and requires the agent to get `typecheck`, `test` and `build` green _inside the sandbox_ before committing. The commits are synced back to a local checkout, where the host re-runs the same three gates itself — the agent's own verdict is an input to the decision, never the decision — and only then pushes a branch and opens a pull request. Issues run in waves, in an order derived from GitHub's native issue dependencies, so independent work happens in parallel and a failure only stands down the issues that actually needed it. Nothing that can spend money or write to GitHub is ever visible to the agent: the sandbox receives no GitHub, Vercel, Blob or AssemblyAI credential.

The git history reads as the record of that run — one merged pull request per issue, each with the agent's account of what it built and what a reviewer should look at twice.

<details>
<summary>The last run, verbatim: five issues, five waves, five merged pull
requests</summary>

```
➜  terpnos-logos-checker git:(master) npm run sandcastle

> terpnos-logos-checker@0.1.0 sandcastle
> tsx --env-file-if-exists=.env --env-file-if-exists=.sandcastle/.env .sandcastle/main.mts

From https://github.com/xavxyz/terpnos-logos-checker
 * branch            master     -> FETCH_HEAD

=== Wave 1/7: already done, skipping ===

=== Wave 2/7: already done, skipping ===

=== Wave 3/7: #6 ===
[#6] removed the worktree /Users/xavier/dev/hacks/terpnos-logos-checker/.sandcastle/worktrees/agent-issue-6; anything uncommitted in it is gone
[#6] reclaimed agent/issue-6 from an earlier attempt; its commits are kept at refs/sandcastle/attempts/issue-6/2026-09-03T08-52-59-778Z
[#6] Envoi de l’audio directement vers Vercel Blob, puis suppression
[#6] branch agent/issue-6, model claude-opus-5
[issue-6] Started on branch agent/issue-6
  tail -f .sandcastle/logs/agent-issue-6-issue-6.log
[#6] 1 commit(s) on agent/issue-6
[#6] The browser now uploads the recording straight to Vercel Blob using a token the server mints for one pathname, and the server deletes that blob at the end of the flow, on failure, and on abandonment — with a sweep of stale recordings as a last resort for a browser that dies silently. Worth a reviewer's eye: the single-use property rests on a random pathname plus `allowOverwrite: false` rather than a consumed nonce (no database in this project), and the deletion is keyed on the pathname rather than the returned URL, which is what makes a never-finished upload cleanable. Nothing was unit-tested here by design — it is all orchestration above the `buildReport` seam.
Switched to branch 'agent/issue-6'
remote:
remote: Create a pull request for 'agent/issue-6' on GitHub by visiting:
remote:      https://github.com/xavxyz/terpnos-logos-checker/pull/new/agent/issue-6
remote:
To https://github.com/xavxyz/terpnos-logos-checker.git
 * [new branch]      agent/issue-6 -> agent/issue-6
Switched to branch 'master'
From https://github.com/xavxyz/terpnos-logos-checker
 * branch            master     -> FETCH_HEAD
   d3eb746..b388cb6  master     -> origin/master
[#6] merged: https://github.com/xavxyz/terpnos-logos-checker/pull/20

=== Wave 4/7: #7 ===
[#7] Transcription AssemblyAI avec étapes de progression nommées
[#7] branch agent/issue-7, model claude-opus-5
[issue-7] Started on branch agent/issue-7
  tail -f .sandcastle/logs/agent-issue-7-issue-7.log
[#7] 1 commit(s) on agent/issue-7
[#7] The server starts an AssemblyAI job from the blob URL and hands back a job reference; the browser polls a server route behind the named steps Envoi / Transcription / Comparaison, and the server deletes the recording in the request that learns the transcript is in, or that it failed. Failures are values at the boundary, each a French sentence that says either retry or warn the owner. Two things for the reviewer: the transcript is not yet consumed — the comparison step is displayed as reached with an explicit "pas encore branchée" note, left for the report slice — and ASSEMBLYAI_API_KEY is documented in .env.example and must be set in Vercel (a fresh key: the prototype's was shared in plain text and must be revoked).
Switched to branch 'agent/issue-7'
remote:
remote: Create a pull request for 'agent/issue-7' on GitHub by visiting:
remote:      https://github.com/xavxyz/terpnos-logos-checker/pull/new/agent/issue-7
remote:
To https://github.com/xavxyz/terpnos-logos-checker.git
 * [new branch]      agent/issue-7 -> agent/issue-7
Switched to branch 'master'
From https://github.com/xavxyz/terpnos-logos-checker
 * branch            master     -> FETCH_HEAD
   b388cb6..2041b06  master     -> origin/master
[#7] merged: https://github.com/xavxyz/terpnos-logos-checker/pull/21

=== Wave 5/7: #8 ===
[#8] Rapport de bout en bout : coller, déposer, lire
[#8] branch agent/issue-8, model claude-opus-5
[issue-8] Started on branch agent/issue-8
  tail -f .sandcastle/logs/agent-issue-8-issue-8.log
[#8] 1 commit(s) on agent/issue-8
[#8] Wired the existing comparison seam into the submission screen: the pasted terpnos logos and the real transcript go into buildReport in the browser, and the document it returns is shown in the page through an iframe srcDoc, unmodified and unreshaped. Added the two French failure messages the chain was missing (empty terpnos logos, failed comparison), made 'Comparaison' a step that actually paints, and guarded against a second submission landing on a flow in progress. The reviewer should look at two choices: running buildReport client-side (which is what keeps the terpnos logos off every server) and rendering the report in a script-less same-origin iframe sized to its own body height (which is what keeps the report byte-identical instead of unwrapping its HTML into the page).
Switched to branch 'agent/issue-8'
remote:
remote: Create a pull request for 'agent/issue-8' on GitHub by visiting:
remote:      https://github.com/xavxyz/terpnos-logos-checker/pull/new/agent/issue-8
remote:
To https://github.com/xavxyz/terpnos-logos-checker.git
 * [new branch]      agent/issue-8 -> agent/issue-8
Switched to branch 'master'
From https://github.com/xavxyz/terpnos-logos-checker
 * branch            master     -> FETCH_HEAD
   2041b06..fe5dde3  master     -> origin/master
[#8] merged: https://github.com/xavxyz/terpnos-logos-checker/pull/22

=== Wave 6/7: #9 ===
[#9] Lecteur audio épinglé et clic pour écouter
[#9] branch agent/issue-9, model claude-opus-5
[issue-9] Started on branch agent/issue-9
  tail -f .sandcastle/logs/agent-issue-9-issue-9.log
[#9] 1 commit(s) on agent/issue-9
[#9] The report already gave every difference its moment; this slice wires it to a player. The Rapport component gained a sticky audio player fed by the dropped File through an object URL, and a click listener on the report's document that seeks the player to the clicked difference's data-start. Two things worth a reviewer's eye: the wiring depends on parent access to the srcDoc iframe's document under sandbox="allow-same-origin" — the same access the existing height measurement already ships with, which keeps the report itself script-free — and playback after the seek is best-effort (a rejected play() is swallowed), so the seek always lands even if a browser declines to autoplay.
Switched to branch 'agent/issue-9'
remote:
remote: Create a pull request for 'agent/issue-9' on GitHub by visiting:
remote:      https://github.com/xavxyz/terpnos-logos-checker/pull/new/agent/issue-9
remote:
To https://github.com/xavxyz/terpnos-logos-checker.git
 * [new branch]      agent/issue-9 -> agent/issue-9
Switched to branch 'master'
From https://github.com/xavxyz/terpnos-logos-checker
 * branch            master     -> FETCH_HEAD
   fe5dde3..78a5c1d  master     -> origin/master
[#9] merged: https://github.com/xavxyz/terpnos-logos-checker/pull/23

=== Wave 7/7: #10 ===
[#10] Copier le rapport formaté et le télécharger
[#10] branch agent/issue-10, model claude-opus-5
[issue-10] Started on branch agent/issue-10
  tail -f .sandcastle/logs/agent-issue-10-issue-10.log
[#10] 1 commit(s) on agent/issue-10
[#10] Added `src/report/handoff.ts`, which turns the report into its two clipboard flavours (inlining the report's styles onto the elements, since a stylesheet does not survive a paste into Google Docs or Notion, and converting newlines to `<br>`) and saves it verbatim as a self-contained HTML file; the two French-labelled buttons sit above the report in `submission-form.tsx`. No tests were added: this is orchestration over the clipboard and download APIs, above the `buildReport` seam that issue #1 fixes as the only tested boundary — I verified the behaviour instead with a throwaway jsdom harness, which caught and let me fix a real quoting bug in the wrapper's `style` attribute. Reviewer should look at `reportFlavours` in `src/report/handoff.ts`, in particular the assumption that the report's marked spans carry exactly one class each.
Switched to branch 'agent/issue-10'
remote:
remote: Create a pull request for 'agent/issue-10' on GitHub by visiting:
remote:      https://github.com/xavxyz/terpnos-logos-checker/pull/new/agent/issue-10
remote:
To https://github.com/xavxyz/terpnos-logos-checker.git
 * [new branch]      agent/issue-10 -> agent/issue-10
Switched to branch 'master'
From https://github.com/xavxyz/terpnos-logos-checker
 * branch            master     -> FETCH_HEAD
   78a5c1d..8c93010  master     -> origin/master
[#10] merged: https://github.com/xavxyz/terpnos-logos-checker/pull/24

=== Summary ===
  #6 landed — https://github.com/xavxyz/terpnos-logos-checker/pull/20
  #7 landed — https://github.com/xavxyz/terpnos-logos-checker/pull/21
  #8 landed — https://github.com/xavxyz/terpnos-logos-checker/pull/22
  #9 landed — https://github.com/xavxyz/terpnos-logos-checker/pull/23
  #10 landed — https://github.com/xavxyz/terpnos-logos-checker/pull/24

Pipeline complete.
```

</details>

[`.sandcastle/README.md`](.sandcastle/README.md) is the operating manual: setup, the two-env-file security boundary, what to do when an agent fails, and the things that will bite. The harness is not part of the application, and agents are forbidden from editing it.

## Layout

| Path | What lives there |
| --- | --- |
| `src/app` | The pages and the API routes (upload token, deletion, transcription). |
| `src/auth` | The shared password and the remembered session. |
| `src/recording` | Accepted formats and the Blob upload. |
| `src/report` | Tokenising, normalisation, the diff, and `buildReport` — the comparison seam. |
| `src/transcription` | The AssemblyAI provider and the polling. |
| `.sandcastle` | The agent harness. Not the application. |
| `CONTEXT.md`, `docs/` | The domain vocabulary and the conventions agents work under. |

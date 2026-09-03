# Sandcastle harness

Drives the implementation of this repository's GitHub issues with Claude Code
agents running in Vercel Sandbox microVMs.

This directory is the orchestrator, not the application. Agents are told not to
edit it, and editing it mid-run has no effect on a run already in flight. It
keeps its own `tsconfig.json` and its own test run for the same reason — the
application's gates are what agents must clear, and the harness has no business
in them:

```bash
npm run sandcastle:check   # typecheck the orchestrator
npm run sandcastle:test    # its scheduling rules
```

## How a run works

1. The host reads the issue with `gh` and interpolates it into `prompt.md`.
2. A fresh Vercel Sandbox starts; Claude Code is installed into it and given the
   repository as a git clone.
3. The agent implements the issue and must get `npm run typecheck`, `npm test`
   and `npm run build` green **inside the sandbox**, then commits.
4. The agent emits a `<verdict>` listing every acceptance criterion and whether
   it met it.
5. Sandcastle syncs the commits back to this checkout. The host then re-runs all
   three gates itself against the synced branch — the agent's verdict is an
   input to the decision, never the decision — and rejects any run that modified
   `.sandcastle/`.
6. The host pushes the branch, opens a pull request, and — for issues not
   reserved for human review — merges it.

The sandbox never receives a GitHub token, a Vercel token, the AssemblyAI key,
or a Blob token. Everything that writes to GitHub runs on your machine under
your own `gh` login.

## Setup

```bash
cp .sandcastle/.env.example .sandcastle/.env
claude setup-token          # paste the result as CLAUDE_CODE_OAUTH_TOKEN
cp .env.example .env        # then fill in VERCEL_TOKEN
```

Two env files, and which one a credential goes in is a security decision.
Sandcastle builds the sandbox's environment from the *keys* of
`.sandcastle/.env`, so everything there is readable by the autonomous agent —
and a key that is not there is never forwarded, even when the host process has
it. `.env` at the repository root is therefore host-only: `npm run sandcastle`
loads it into the orchestrator, and nothing copies it into the microVM. The
Vercel token lives there because the agent has no business holding a credential
that can spend on your account. `main.mts` refuses to start if it finds
`VERCEL_TOKEN` in `.sandcastle/.env`, and refuses to start with no token at all
rather than failing later with an opaque SDK error. Then:

```bash
npm install
npm run sandcastle -- --dry-run    # prints the plan, runs nothing
npm run sandcastle -- --only 11    # scaffolding issue only
npm run sandcastle                 # the whole pipeline
```

Run it from a clean working tree on `master`. The script refuses to start
otherwise, because agents' commits are applied onto this checkout.

`SANDCASTLE_MODEL` overrides the model if you want to trade quality for compute
on a wave you are less worried about.

## When an agent fails

One agent dying no longer ends the run. Its siblings in the same wave are left
to finish, whatever they produce is landed as usual, and the failure is recorded
against that issue.

What happens next depends on what actually needed that issue. The waves above
are an execution order, not a dependency graph; the real one lives in GitHub's
native issue dependencies, which `main.mts` reads at startup. Only the issues
that transitively depend on a failure are skipped — if the Blob upload (#6) dies
the whole I/O chain below it stands down, while the comparison chain (#4) runs
to completion. If those dependencies cannot be read at all, the run stops at the
first failure rather than guess.

The run ends with a summary of what landed, what failed and what was skipped,
and exits non-zero if anything failed. A failed issue leaves its branch behind
and Sandcastle refuses to reuse an existing branch, so delete it before
retrying — the summary prints the exact command, along with the path to each
failed agent's transcript under `.sandcastle/logs/`.

## It stops on purpose

Issues #11, #2 and #3 open a **draft** pull request and the pipeline halts:
later waves branch from `master`, so continuing before you have merged them
would build on scaffolding, an auth shape, or a `buildReport` seam that does not
exist yet. Review the draft, merge it, and run the same command again — closed
issues are skipped, so it picks up where it left off.

## Start with one issue

Run `--only 11` first and watch it. It is the cheapest way to find out whether
the sandbox bootstrap works before spending the month's compute on six waves.

## Things that will bite

**The Claude install hook.** The Vercel provider ignores
`.sandcastle/Dockerfile`, so `claude` is installed by an `onSandboxReady` hook
in `main.mts` and symlinked onto `PATH`. If a run dies immediately with a
command-not-found, that hook is what to fix. It is the one part of this harness
that has not been executed against a real sandbox.

**The compute budget, not the clock.** Vercel Hobby gives 5 Active-CPU-hours per
month; when they are gone, sandbox creation is paused until the billing cycle
resets. `npm install` and `next build` are what actually consume it — the agent
waiting on model responses is nearly free. A 45-minute session cap also applies,
and `main.mts` sets the timeout explicitly because the provider's own default is
5 minutes.

**Sync-out rewrites commit SHAs.** Commits come back through
`git format-patch` / `git am --3way`. A long, divergent run can fail to apply
cleanly. That looks like lost work but is not: the patches are on disk under
`.sandcastle/patches/`.

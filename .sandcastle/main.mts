/**
 * Sandcastle orchestrator for terpnos-logos-checker.
 *
 * Runs on your machine. Each issue gets one Claude Code agent in a fresh Vercel
 * Sandbox microVM; the agent implements the issue and commits. Sandcastle syncs
 * those commits back to this checkout, the host re-runs the gates itself, and
 * everything that touches GitHub happens here on the host — the sandbox never
 * holds a GitHub token, an AssemblyAI key, or a Vercel token.
 *
 *   npx tsx .sandcastle/main.mts               # the whole pipeline
 *   npx tsx .sandcastle/main.mts --only 11     # one issue
 *   npx tsx .sandcastle/main.mts --dry-run     # print the plan, run nothing
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeCode,
  createIsolatedSandboxProvider,
  Output,
  run,
  type IsolatedCreateOptions,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "@ai-hero/sandcastle";
import { vercel, type VercelOptions } from "@ai-hero/sandcastle/sandboxes/vercel";
import { z } from "zod";

import { detachedExec } from "./detached-exec.mts";
import { planWave, type Blockers } from "./plan.mts";

const BASE_BRANCH = "master";
const MODEL = process.env.SANDCASTLE_MODEL ?? "claude-opus-5";

/**
 * Issues in dependency order. Each inner array is a wave whose issues have no
 * dependency on each other and whose agents run concurrently.
 *
 * #11 scaffolds the project. Then the two chains run in parallel — {2,6,7} is
 * the I/O side (app shell, Blob upload, transcription) and {3,4} is the pure
 * comparison side — converging on #8.
 *
 * #9 and #10 are deliberately sequential despite both depending only on #8:
 * they both edit the report UI and would collide.
 *
 * This is an execution order, not a statement of what depends on what — which a
 * failing agent makes the pipeline need to know. See `readBlockers`.
 */
const WAVES: number[][] = [[11], [2, 3], [6, 4], [7], [8], [9], [10]];

/**
 * Issues whose pull request is opened as a draft and left for a human. These
 * three establish the patterns every later issue inherits — the project
 * scaffolding, the auth shape, and the `buildReport` seam — so a mistake here
 * is a mistake in eight downstream issues.
 *
 * The pipeline stops after any wave containing one of these: later waves branch
 * from `master`, so continuing before the human has merged would build the next
 * issue on scaffolding that does not exist yet.
 */
const REVIEW_BY_HUMAN = new Set([11, 2, 3]);

/**
 * Vercel Hobby caps a sandbox session at 45 minutes. Sandcastle's Vercel
 * provider defaults to 5 minutes and never calls `extendTimeout()`, so this
 * must be set explicitly or long runs die for no visible reason.
 */
const SANDBOX_TIMEOUT_MS = 44 * 60 * 1000;

/**
 * Each vCPU carries 2 GB of memory. Hobby allows up to 4, but the free tier's
 * real ceiling is 5 Active-CPU-hours per month — and once it is spent, sandbox
 * creation is paused until the billing cycle resets.
 */
const VCPUS = 2;

/**
 * How often the host asks the sandbox whether the agent has finished.
 *
 * Every poll is a fresh sub-second request, so this is the only thing standing
 * between a long run and an idle-timeout kill. Five seconds keeps the live log
 * feeling live and the request count negligible against a run measured in
 * tens of minutes.
 */
const AGENT_POLL_INTERVAL_MS = 5_000;

/**
 * A Vercel sandbox provider that delivers stdin and survives a dropped stream.
 *
 * Two upstream defects meet on the same command — the one that runs the agent.
 *
 * First, `@ai-hero/sandcastle@0.12.0`'s Vercel provider drops `exec`'s `stdin`
 * option on the floor: it never wires anything to `sandbox.runCommand`. The
 * Claude Code provider passes the prompt as `claude … --print … -p -`, meaning
 * "read the prompt from stdin" — so with stdin missing the agent is handed the
 * literal string `-` and asks what you want it to do. That is not a
 * misconfiguration of this harness; it is a broken contract, since
 * `IsolatedSandboxHandle.exec` documents that `stdin` MUST be piped to the
 * child. Every other provider honours it.
 *
 * Second, `@vercel/sandbox`'s `runCommand({ wait: true })` keeps a single HTTP
 * stream open for the command's entire life and reads exactly two chunks from
 * it — one at launch, one at exit. For an agent that socket is silent for an
 * hour, and anything on the path with an idle timeout eventually closes it.
 * That surfaces as `exec failed: terminated` or `Stream ended before command
 * finished`, both of which killed issue #6 three times over while the sandbox
 * was still working perfectly. See `detached-exec.mts`.
 *
 * Both fixes stay out of `node_modules`, and both apply to exactly the commands
 * that carry `stdin` — which, here, means the agent and nothing else. Short
 * commands keep the direct path, where a held-open stream costs nothing.
 *
 * Delete this the day the upstream provider pipes stdin and stops betting an
 * hour of work on one uninterrupted socket.
 */
const vercelWithStdin = (options: VercelOptions): IsolatedSandboxProvider => {
  // `create` is part of the provider object but not of its public type; the
  // config type is where it is declared.
  const inner = vercel(options) as IsolatedSandboxProvider & {
    create: (options: IsolatedCreateOptions) => Promise<IsolatedSandboxHandle>;
  };

  return createIsolatedSandboxProvider({
    name: inner.name,
    env: inner.env,
    create: async (createOptions) => {
      const handle = await inner.create(createOptions);

      return {
        ...handle,
        exec: async (command, execOptions) => {
          if (execOptions?.stdin === undefined) return handle.exec(command, execOptions);

          return detachedExec(handle, command, execOptions, {
            pollIntervalMs: AGENT_POLL_INTERVAL_MS,
            timeoutMs: SANDBOX_TIMEOUT_MS,
          });
        },
      };
    },
  });
};

/**
 * Where the Vercel token is allowed to live, and where it is not.
 *
 * Sandcastle builds the sandbox's environment from the *keys* of
 * `.sandcastle/.env` — a key absent from that file is never forwarded, even
 * when the host process has it. So the token that can spend on your Vercel
 * account goes in the repository-root `.env`, which `npm run sandcastle` loads
 * into this process and nothing copies into the microVM. Both files are
 * git-ignored.
 *
 * Putting it in `.sandcastle/.env` instead would hand an autonomous agent a
 * billable credential, which is why that is a hard error rather than a warning.
 */
const HOST_ONLY_ENV_FILE = ".env";
const SANDBOX_ENV_FILE = ".sandcastle/.env";

/** Does an env file define this key? Comments and `export ` prefixes ignored. */
const envFileDefines = (path: string, key: string): boolean => {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const definition = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  return contents.split("\n").some((line) => definition.test(line));
};

/**
 * The three keys `@vercel/sandbox` needs together, and the reason all three are
 * required rather than just the token.
 *
 * `getCredentials()` in `@vercel/sandbox` takes an all-or-nothing view: it uses
 * the explicit `token`/`teamId`/`projectId` triple only when all three are
 * present, and otherwise ignores what it was given and goes down the OIDC path
 * — which on a developer machine dead-ends in "Could not get credentials from
 * OIDC context. Please link your Vercel project…". A token on its own therefore
 * does not fail as a bad token; it fails as a missing OIDC context, several
 * layers away from the actual cause.
 *
 * Note that the SDK does not read `VERCEL_TOKEN` from the environment itself,
 * despite what the provider's option docs suggest. Reading the environment and
 * passing the triple explicitly is this harness's job.
 */
const VERCEL_KEYS = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const;

interface VercelCredential {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

/**
 * Fail before a sandbox is created rather than after, and fail with the fix in
 * the message: a missing key otherwise surfaces as an opaque OIDC error, and a
 * leaked one surfaces as nothing at all.
 */
const resolveVercelCredential = (): VercelCredential => {
  const leaked = VERCEL_KEYS.filter((key) => envFileDefines(SANDBOX_ENV_FILE, key));
  if (leaked.length > 0) {
    throw new Error(
      `${SANDBOX_ENV_FILE} defines ${leaked.join(", ")}. Every key in that file is ` +
        `forwarded into the sandbox, so this would hand the agent credentials that can ` +
        `spend on your Vercel account. Move ${leaked.length === 1 ? "that line" : "those lines"} ` +
        `to ${HOST_ONLY_ENV_FILE} at the repository root, which stays on the host.`,
    );
  }

  const missing = VERCEL_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Vercel credential, missing: ${missing.join(", ")}. @vercel/sandbox ` +
        `needs all of ${VERCEL_KEYS.join(", ")} together — with any of them absent it ` +
        `falls back to OIDC and fails with "Could not get credentials from OIDC ` +
        `context". Put all three in ${HOST_ONLY_ENV_FILE} at the repository root (see ` +
        `.env.example) — \`npm run sandcastle\` loads it on the host and never forwards ` +
        `it to the agent. The team and project IDs are on your project's Vercel ` +
        `settings page, or from \`npx vercel link\` in .vercel/project.json.`,
    );
  }

  return {
    token: process.env.VERCEL_TOKEN!,
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!,
  };
};

/** The gates every issue must clear. Names fixed by issue #11. */
const GATES = [
  ["typecheck", ["run", "typecheck"]],
  ["tests", ["test"]],
  ["build", ["run", "build"]],
] as const;

/** The agent's self-assessment against its issue's acceptance criteria. */
const Verdict = z.object({
  gates: z.object({
    typecheck: z.boolean(),
    tests: z.boolean(),
    build: z.boolean(),
  }),
  criteria: z.array(
    z.object({
      text: z.string(),
      met: z.boolean(),
      note: z.string().default(""),
    }),
  ),
  summary: z.string(),
});

type Verdict = z.infer<typeof Verdict>;

/** What one agent produced, before any of it has touched GitHub. */
interface AgentRun {
  readonly issue: number;
  readonly title: string;
  readonly branch: string;
  readonly verdict: Verdict;
  readonly commitCount: number;
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

const gh = (...args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8" }).trim();

const log = (issue: number, message: string) =>
  console.log(`[#${issue}] ${message}`);

const list = (issues: readonly number[]) => issues.map((issue) => `#${issue}`).join(", ");

/**
 * One definition, because the end-of-run summary tells you to `git branch -D`
 * these: a second copy of the pattern that drifted would print a command that
 * deletes the wrong thing, or nothing.
 */
const agentBranch = (issue: number) => `agent/issue-${issue}`;

/**
 * Where Sandcastle writes an agent's transcript. The doubled segment is its
 * own convention — `agent-<run name>-<agent name>` where both are `issue-N` —
 * observed from the files it produces, not documented anywhere.
 */
const agentLog = (issue: number) => `.sandcastle/logs/agent-issue-${issue}-issue-${issue}.log`;

/** Inferred from the checkout rather than hardcoded, per docs/agents/issue-tracker.md. */
const REPO = gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");

const issueTitle = (issue: number) =>
  gh("issue", "view", String(issue), "--repo", REPO, "--json", "title", "-q", ".title");

const issueBody = (issue: number) =>
  gh("issue", "view", String(issue), "--repo", REPO, "--json", "body", "-q", ".body");

/** Does this checkout already have a branch by this name? */
const branchExists = (branch: string) =>
  succeeds("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);

/**
 * Where Sandcastle parks the worktree it keeps when an agent leaves
 * uncommitted changes behind. Nothing outside this directory is a worktree
 * this harness created, and so nothing outside it is a worktree this harness
 * removes.
 */
const HARNESS_WORKTREES =
  join(git("rev-parse", "--show-toplevel"), ".sandcastle", "worktrees") + "/";

/**
 * The worktree that currently has `branch` checked out, or `null`. Git refuses
 * to delete a branch a worktree holds, and the porcelain listing is the only
 * place that mapping is written down.
 */
const worktreeHolding = (branch: string): string | null => {
  let path: string | null = null;

  for (const line of git("worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }

  return null;
};

/**
 * Where a superseded attempt's commits go: under `refs/sandcastle/`, not under
 * `refs/heads/`. They stay fetchable — `git log <ref>`, `git checkout -b …
 * <ref>` — while being out of the branch namespace, so they cannot be pushed
 * by accident, do not clutter `git branch`, and cannot collide with the branch
 * the next attempt cuts.
 */
const attemptRef = (issue: number) =>
  `refs/sandcastle/attempts/issue-${issue}/${new Date().toISOString().replace(/[:.]/g, "-")}`;

/**
 * Make this issue's branch name available again, so a retry is just a re-run.
 *
 * Sandcastle ignores `baseBranch` when the branch already exists, which is why
 * an earlier attempt's leftover branch cannot simply be reused: the new agent
 * would build on whatever `master` looked like when the failed attempt
 * started, and by then it is usually several merges stale. The branch has to go.
 *
 * This used to be the operator's job, announced as a `git branch -D` in the
 * summary — but every failure then cost a manual step before the obvious next
 * command would work at all, and the step was the same one every time. It is
 * done here instead. The commits are not thrown away: they are first parked on a
 * ref under `refs/sandcastle/attempts/` and the ref is printed, so a failed
 * attempt worth salvaging still can be. Uncommitted changes in a preserved
 * worktree are the one thing that does not survive, which is why removing one
 * is announced rather than done quietly.
 */
const reclaimBranch = (issue: number): void => {
  const branch = agentBranch(issue);
  if (!branchExists(branch)) return;

  const worktree = worktreeHolding(branch);
  if (worktree !== null) {
    // Only ever Sandcastle's own. A branch held by some worktree a human set up
    // is a situation this cannot reason about, and removing it would take
    // uncommitted work with it.
    if (!worktree.startsWith(HARNESS_WORKTREES)) {
      throw new Error(
        `${branch} is checked out in the worktree at ${worktree}, which Sandcastle did ` +
          `not create. Refusing to remove it — resolve it by hand, then run this again.`,
      );
    }
    git("worktree", "remove", "--force", worktree);
    log(issue, `removed the worktree ${worktree}; anything uncommitted in it is gone`);
  }

  const ref = attemptRef(issue);
  git("update-ref", ref, `refs/heads/${branch}`);
  git("branch", "-D", branch);
  log(issue, `reclaimed ${branch} from an earlier attempt; its commits are kept at ${ref}`);
};

/**
 * The pipeline halts at each human-review wave and is re-run afterwards, so it
 * has to be resumable: an issue closed by a merged pull request is already done.
 */
const isClosed = (issue: number) =>
  gh("issue", "view", String(issue), "--repo", REPO, "--json", "state", "-q", ".state") === "CLOSED";

const succeeds = (command: string, args: string[]): boolean => {
  try {
    execFileSync(command, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The pull request a branch produced. Only used to label an issue whose pull
 * request merged but whose run stopped immediately afterwards, which is why it
 * degrades to a bare note rather than throwing: the run is already reporting
 * one failure and a second one from the lookup would bury it.
 */
const mergedPrUrl = (branch: string): string => {
  try {
    return (
      gh("pr", "list", "--repo", REPO, "--head", branch, "--state", "all", "--json", "url", "-q", ".[0].url") ||
      "merged (pull request URL unavailable)"
    );
  } catch {
    return "merged (pull request URL unavailable)";
  }
};

/**
 * The dependency graph, read from GitHub's native issue dependencies.
 *
 * `docs/agents/issue-tracker.md` names these the canonical, UI-visible
 * representation of blocking, so they are read rather than restated here: a
 * second copy in this file would drift the first time an edge is added in the
 * GitHub UI, and it would drift silently.
 *
 * Follows edges out of the requested issues so the graph is complete even under
 * `--only`, where the waves name one issue but its blockers reach further back.
 *
 * Returns `null` when any lookup fails — the endpoint is comparatively new and
 * a repository may not have it. A partial graph is worse than none: it would
 * report an issue as safe to build when its blocker had in fact just died, so
 * the caller degrades to halting the run instead.
 */
const readBlockers = (issues: readonly number[]): Blockers | null => {
  const blockers = new Map<number, readonly number[]>();
  const queue = [...issues];

  while (queue.length > 0) {
    const issue = queue.shift()!;
    if (blockers.has(issue)) continue;

    let listed: number[];
    try {
      listed = JSON.parse(
        gh("api", `repos/${REPO}/issues/${issue}/dependencies/blocked_by`, "--jq", "[.[].number]"),
      ) as number[];
    } catch (error) {
      console.warn(
        `Could not read GitHub issue dependencies for #${issue} (${describeError(error)}).\n` +
          `Without the graph this run cannot tell which issues a failure invalidates, so ` +
          `it will stop at the first failure rather than skip only the affected work.`,
      );
      return null;
    }

    blockers.set(issue, listed);
    queue.push(...listed);
  }

  return blockers;
};

/** What became of one issue in this run. */
type Outcome =
  | { readonly kind: "landed"; readonly issue: number; readonly prUrl: string }
  | {
      readonly kind: "failed";
      readonly issue: number;
      readonly phase: "agent" | "landing";
      readonly reason: string;
    }
  | { readonly kind: "skipped"; readonly issue: number; readonly by: readonly number[] };

/**
 * Phase one: implement the issue in a sandbox. Deliberately does no host git
 * work beyond what Sandcastle itself does on its own named branch, because the
 * whole wave runs concurrently against a single checkout.
 */
const implementIssue = async (
  issue: number,
  credential: VercelCredential,
): Promise<AgentRun> => {
  // Free of leftovers by the time this runs: `reclaimBranch` is the caller's
  // first move on every issue it hands over.
  const branch = agentBranch(issue);
  const title = issueTitle(issue);
  log(issue, title);
  log(issue, `branch ${branch}, model ${MODEL}`);

  const result = await run({
    name: `issue-${issue}`,
    agent: claudeCode(MODEL),
    sandbox: vercelWithStdin({
      timeout: SANDBOX_TIMEOUT_MS,
      resources: { vcpus: VCPUS },
      runtime: "node24",
      // All three, or the SDK silently ignores them and tries OIDC instead.
      ...credential,
    }),
    promptFile: `${process.cwd()}/.sandcastle/prompt.md`,
    // The issue text is read here, on the host, under your own `gh` login, and
    // substituted into the prompt. It cannot be read with a !`…` expression in
    // prompt.md: those execute inside the sandbox, which deliberately has no
    // GitHub token and no `gh` binary, and a non-zero exit aborts the run.
    promptArgs: {
      ISSUE_NUMBER: issue,
      ISSUE_TITLE: title,
      ISSUE_BODY: issueBody(issue),
      PARENT_SPEC: issueBody(1),
    },
    // Concurrent runs in the same wave must not share a branch. `head` and
    // `merge-to-head` are unsafe for concurrent work; a named branch per issue
    // is the only strategy that is.
    branchStrategy: { type: "branch", branch, baseBranch: BASE_BRANCH },
    // Deliberately no abort signal. An earlier version cancelled a wave's
    // remaining agents as soon as one failed, to protect the month's compute
    // budget. That trade is the wrong way round: the common failure here is
    // infrastructural and unrelated to the work — a dropped sandbox exec
    // stream, say — and killing a sibling that is minutes from committing
    // guarantees nothing is salvaged from compute already spent. Each sandbox
    // caps itself at SANDBOX_TIMEOUT_MS, so the exposure is bounded anyway.
    hooks: {
      sandbox: {
        onSandboxReady: [
          // The Vercel provider ignores `.sandcastle/Dockerfile` entirely — it
          // is a bind-mount/Docker concept. Without this the `claude` binary
          // does not exist in the sandbox and the run fails immediately.
          {
            command:
              "curl -fsSL https://claude.ai/install.sh | bash && " +
              '( ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude || ' +
              'sudo ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude ) && ' +
              // Proves the binary is on PATH. Without it a failed install is
              // silent here and reappears as a confusing failure much later.
              "claude --version",
            timeoutMs: 180_000,
          },
        ],
      },
    },
    output: Output.object({ tag: "verdict", schema: Verdict, maxRetries: 2 }),
  });

  const verdict: Verdict = result.output;
  log(issue, `${result.commits.length} commit(s) on ${result.branch}`);
  log(issue, verdict.summary);

  return {
    issue,
    title,
    branch,
    verdict,
    commitCount: result.commits.length,
  };
};

/**
 * Everything that must be true before an agent's work is allowed onto master.
 * The agent's own verdict is one input, not the decision: the gates are re-run
 * here, on the host, against the code that actually synced back.
 */
const rejections = (agentRun: AgentRun): string[] => {
  const { issue, branch, verdict } = agentRun;
  const problems: string[] = [];

  if (agentRun.commitCount === 0) problems.push("no commits were produced");

  for (const criterion of verdict.criteria) {
    if (!criterion.met) {
      problems.push(`unmet: ${criterion.text}${criterion.note ? ` — ${criterion.note}` : ""}`);
    }
  }

  try {
    git("checkout", branch);
  } catch {
    problems.push(
      `could not check out ${branch} on the host — Sandcastle preserves its worktree ` +
        `when the agent leaves uncommitted changes, and that worktree still holds the ` +
        `branch. Inspect .sandcastle/worktrees/, then \`git worktree remove --force\` it.`,
    );
    return problems;
  }

  // `.sandcastle/` is the harness driving this run. The prompt tells agents not
  // to touch it; this is the part that actually enforces it.
  const touched = git("diff", "--name-only", `${BASE_BRANCH}...${branch}`)
    .split("\n")
    .filter((path) => path.startsWith(".sandcastle/"));
  if (touched.length > 0) {
    problems.push(`modified the harness: ${touched.join(", ")}`);
  }

  if (!succeeds("npm", ["ci"])) {
    problems.push("gate failed on host: npm ci");
    return problems;
  }

  for (const [name, args] of GATES) {
    if (!succeeds("npm", [...args])) {
      problems.push(`gate failed on host: ${name}`);
    }
    if (!verdict.gates[name]) {
      log(issue, `note: agent self-reported ${name} as failing`);
    }
  }

  return problems;
};

/**
 * Phase two: land one agent's work. Serialized across a wave — it checks out
 * branches and moves `master`, so two of these at once would race.
 * Returns the pull request URL.
 */
const land = async (agentRun: AgentRun): Promise<string> => {
  const { issue, title, branch, verdict } = agentRun;
  const needsHumanReview = REVIEW_BY_HUMAN.has(issue);

  const problems = rejections(agentRun);
  if (problems.length > 0) {
    throw new Error(
      `Issue #${issue} is not landable:\n  ${problems.join("\n  ")}\n` +
        `Its commits are on the local branch ${branch}. Inspect, fix or re-run.`,
    );
  }

  git("push", "--force-with-lease", "-u", "origin", branch);

  const body =
    `${verdict.summary}\n\n` +
    `Closes #${issue}\n\n` +
    `Implemented autonomously by Sandcastle. Gates re-run on the host, and the ` +
    `agent reported these acceptance criteria met:\n` +
    verdict.criteria.map((criterion) => `- [x] ${criterion.text}`).join("\n");

  const prUrl = gh(
    "pr", "create",
    "--repo", REPO,
    "--base", BASE_BRANCH,
    "--head", branch,
    "--title", `${title} (#${issue})`,
    "--body", body,
    ...(needsHumanReview ? ["--draft"] : []),
  );

  git("checkout", BASE_BRANCH);

  if (needsHumanReview) {
    log(issue, `draft PR awaiting your review: ${prUrl}`);
    return prUrl;
  }

  gh("pr", "merge", prUrl, "--repo", REPO, "--squash", "--delete-branch");
  git("pull", "--ff-only", "origin", BASE_BRANCH);
  log(issue, `merged: ${prUrl}`);
  return prUrl;
};

/**
 * `land` checks out the agent's branch to re-run the gates and only returns to
 * `BASE_BRANCH` once it has succeeded. Now that a failure no longer ends the
 * process, everything after it — the next issue in the wave, the next wave —
 * would inherit whatever branch the failure left behind.
 */
const restoreBaseBranch = (): boolean => {
  try {
    git("checkout", BASE_BRANCH);
    return true;
  } catch (error) {
    console.error(
      `Could not return to ${BASE_BRANCH} after a failed landing ` +
        `(${describeError(error)}). Stopping rather than running the rest of the ` +
        `pipeline against an unknown checkout.`,
    );
    return false;
  }
};

/**
 * The end-of-run account. Printed even when everything worked, because "which
 * pull requests did this open" is the question asked every time, and printed
 * especially when things did not: a failed issue usually leaves a branch the
 * next run refuses to reuse, so the cleanup belongs here rather than in the
 * reader's memory.
 *
 * Named `summarise` rather than `report` because CONTEXT.md reserves "report"
 * for the application's own output, the marked-up terpnos logos.
 */
const summarise = (outcomes: readonly Outcome[]): void => {
  // A run where every issue was already closed has nothing to account for, and
  // an empty summary reads like something went missing.
  if (outcomes.length === 0) return;

  console.log("\n=== Summary ===");

  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "landed":
        console.log(`  #${outcome.issue} landed — ${outcome.prUrl}`);
        break;
      case "failed":
        console.log(`  #${outcome.issue} failed in the ${outcome.phase} phase — ${outcome.reason}`);
        break;
      case "skipped":
        console.log(`  #${outcome.issue} skipped — waits on ${list(outcome.by)}`);
        break;
    }
  }

  const failures = outcomes.filter((outcome) => outcome.kind === "failed");
  if (failures.length === 0) return;

  // Only what is actually on disk. An agent that died before Sandcastle cut its
  // branch — while the issue title was being resolved, or the sandbox was coming
  // up — left neither a branch nor a transcript, and naming one of those in the
  // deletion command below makes it fail for every branch after it too.
  const retryable = failures.map((failure) => failure.issue);
  const leftovers = retryable.filter((issue) => branchExists(agentBranch(issue)));

  if (leftovers.length > 0) {
    console.log(
      `\nLeft behind, for you to read if you want to:\n` +
        leftovers
          .map((issue) => `  #${issue}: ${agentBranch(issue)}, ${agentLog(issue)}`)
          .join("\n") +
        `\n\nNo cleanup needed. The next run reclaims these branches itself — it has to,\n` +
        `since Sandcastle ignores baseBranch when a branch already exists and would\n` +
        `otherwise build on a stale ${BASE_BRANCH} — and parks their commits under\n` +
        `refs/sandcastle/attempts/ first, naming the ref as it goes.`,
    );
  }

  console.log(`\nRun this again to retry ${list(retryable)}.`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyIndex = args.indexOf("--only");
  let waves = WAVES;

  if (onlyIndex !== -1) {
    // A malformed --only must never fall through to the full pipeline: that is
    // seven waves of metered sandbox time nobody asked for.
    const only = Number(args[onlyIndex + 1]);
    if (!Number.isInteger(only)) {
      throw new Error(`--only needs an issue number, got: ${args[onlyIndex + 1] ?? "nothing"}`);
    }
    waves = [[only]];
  }

  if (dryRun) {
    console.log(`Repo: ${REPO}, base: ${BASE_BRANCH}, model: ${MODEL}`);

    // The plan is only worth printing if it matches what a real run would do,
    // so this mirrors the execution loop below: closed issues drop out, a wave
    // with nothing left is skipped, and the run returns at the first wave whose
    // remaining issues need human review. Costs one `gh issue view` per issue,
    // resolved up front so no issue is queried twice.
    const closed = new Set(waves.flat().filter((issue) => isClosed(issue)));
    let halted = false;

    waves.forEach((wave, index) => {
      // Planned through the same function the run uses, so the two cannot
      // disagree. Nothing has failed in a dry run, which is also why the
      // dependency graph is not worth fetching here.
      const { todo, skipped } = planWave(wave, { closed, failed: new Set(), blockers: null });
      const done = [...skipped.keys()];

      if (todo.length === 0) {
        console.log(`Wave ${index + 1}: ${list(wave)} — already done, skipping`);
        return;
      }

      const labelled = todo
        .map((issue) => `#${issue}${REVIEW_BY_HUMAN.has(issue) ? " (draft, human review)" : " (auto-merge)"}`)
        .join(", ");
      const alreadyDone = done.length > 0 ? ` (already done: ${list(done)})` : "";

      // Everything after the halting wave is a plan for the *next* invocation,
      // not this one. Saying so beats implying seven waves are about to run.
      if (halted) {
        console.log(`Wave ${index + 1}: ${labelled}${alreadyDone} — not reached this run`);
        return;
      }

      halted = todo.some((issue) => REVIEW_BY_HUMAN.has(issue));
      console.log(`Wave ${index + 1}: ${labelled}${alreadyDone}${halted ? " — pipeline stops here" : ""}`);
    });
    return;
  }

  const credential = resolveVercelCredential();

  // This script moves BASE_BRANCH and checks out agent branches, so it has to
  // own the checkout it runs in. Run it from the main clone, not from a git
  // worktree — a worktree cannot check out a branch another one already holds.
  const currentBranch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (currentBranch !== BASE_BRANCH) {
    throw new Error(
      `Run this from the main checkout with ${BASE_BRANCH} checked out; currently on '${currentBranch}'.`,
    );
  }

  if (git("status", "--porcelain") !== "") {
    throw new Error("Working tree is dirty. Commit or stash before running.");
  }

  git("fetch", "origin");
  git("pull", "--ff-only", "origin", BASE_BRANCH);

  const blockers = readBlockers(waves.flat());
  const outcomes: Outcome[] = [];
  const failed = new Set<number>();
  let stopped: "review" | "checkout" | null = null;

  for (const [index, wave] of waves.entries()) {
    const closed = new Set(wave.filter((issue) => isClosed(issue)));
    const { todo, skipped } = planWave(wave, { closed, failed, blockers });
    const label = `\n=== Wave ${index + 1}/${waves.length}:`;

    if (todo.length > 0) {
      console.log(`${label} ${todo.map((n) => `#${n}`).join(", ")} ===`);
    } else if ([...skipped.values()].every((skip) => skip.kind === "done")) {
      console.log(`${label} already done, skipping ===`);
    } else {
      console.log(`${label} nothing runnable ===`);
    }

    for (const [issue, skip] of skipped) {
      if (skip.kind !== "blocked") continue;
      const causes = skip.by.map((n) => `#${n}`).join(", ");
      log(issue, `skipped: depends on ${causes}, which did not land in this run`);
      outcomes.push({ kind: "skipped", issue, by: skip.by });
    }

    if (todo.length === 0) continue;

    // Before any agent starts, and one at a time: reclaiming moves refs and can
    // remove a worktree, and a wave's agents running concurrently would race
    // each other for the index lock. A branch that cannot be reclaimed fails
    // only its own issue — the rest of the wave is unaffected by it.
    const runnable: number[] = [];
    for (const issue of todo) {
      try {
        reclaimBranch(issue);
        runnable.push(issue);
      } catch (error) {
        const reason = describeError(error);
        failed.add(issue);
        outcomes.push({ kind: "failed", issue, phase: "agent", reason });
        log(issue, `agent failed: ${reason}`);
      }
    }
    if (runnable.length === 0) continue;

    // `allSettled`, not `all`: `all` rejects on the first failure and leaves its
    // siblings' rejections unhandled, which is what turned one dropped sandbox
    // stream into an uncaught exception that killed the whole pipeline.
    const settled = await Promise.allSettled(
      runnable.map((issue) => implementIssue(issue, credential)),
    );

    const agentRuns: AgentRun[] = [];
    for (const [position, result] of settled.entries()) {
      const issue = runnable[position]!;
      if (result.status === "fulfilled") {
        agentRuns.push(result.value);
        continue;
      }
      failed.add(issue);
      const reason = describeError(result.reason);
      outcomes.push({ kind: "failed", issue, phase: "agent", reason });
      log(issue, `agent failed: ${reason}`);
    }

    // Serialized: each of these checks out branches and moves master.
    const landed: number[] = [];
    for (const [position, agentRun] of agentRuns.entries()) {
      try {
        outcomes.push({ kind: "landed", issue: agentRun.issue, prUrl: await land(agentRun) });
        landed.push(agentRun.issue);
        continue;
      } catch (error) {
        const reason = describeError(error);

        // `land` merges the pull request before its last step, so a failure in
        // that tail leaves an issue that is closed: the work did land, and what
        // is broken is this checkout — a `master` that no longer has the merge.
        // Calling that a failed issue would stand down a whole chain of
        // downstream work over something that actually succeeded, so it is
        // treated as the checkout problem it is and the run stops.
        if (isClosed(agentRun.issue)) {
          outcomes.push({
            kind: "landed",
            issue: agentRun.issue,
            prUrl: mergedPrUrl(agentRun.branch),
          });
          console.error(
            `\n#${agentRun.issue} merged, but the step after it failed (${reason}).\n` +
              `This checkout may no longer match ${BASE_BRANCH} on the remote, and later\n` +
              `waves branch from it. Reconcile it, then run this again.`,
          );
          stopped = "checkout";
        } else {
          failed.add(agentRun.issue);
          outcomes.push({ kind: "failed", issue: agentRun.issue, phase: "landing", reason });
          log(agentRun.issue, `not landed: ${reason}`);
          if (!restoreBaseBranch()) stopped = "checkout";
        }
      }

      if (!stopped) continue;

      // Whatever is left in this wave has commits on its branch and no pull
      // request, and stopping here must not make it disappear from the summary:
      // its branch would then be an unexplained leftover blocking the re-run.
      for (const abandoned of agentRuns.slice(position + 1)) {
        failed.add(abandoned.issue);
        outcomes.push({
          kind: "failed",
          issue: abandoned.issue,
          phase: "landing",
          reason: "not attempted — the run stopped while landing an earlier issue",
        });
      }
      break;
    }
    if (stopped) break;

    // Only issues that actually landed can be waiting on a review. One that
    // failed leaves nothing to review, and the work depending on it is skipped
    // by `planWave` in the waves below.
    const awaitingReview = landed.filter((issue) => REVIEW_BY_HUMAN.has(issue));
    if (awaitingReview.length > 0) {
      console.log(
        `\nStopping: ${awaitingReview.map((n) => `#${n}`).join(", ")} ` +
          `${awaitingReview.length === 1 ? "is" : "are"} waiting on your review. ` +
          `Merge the draft PR${awaitingReview.length === 1 ? "" : "s"}, then run this again — ` +
          `later waves branch from ${BASE_BRANCH} and need that work landed first.`,
      );
      stopped = "review";
      break;
    }
  }

  summarise(outcomes);

  if (failed.size > 0) {
    // A non-zero exit matters now that the process no longer crashes on a
    // failed agent: without it a partially failed run looks like a clean one to
    // anything reading the exit code.
    process.exitCode = 1;
    return;
  }

  if (stopped === null) console.log("\nPipeline complete.");
};

await main();

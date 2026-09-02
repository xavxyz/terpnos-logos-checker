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
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
 * A Vercel sandbox provider that actually delivers stdin.
 *
 * `@ai-hero/sandcastle@0.12.0`'s Vercel provider drops `exec`'s `stdin` option
 * on the floor: it never wires anything to `sandbox.runCommand`. The Claude
 * Code provider passes the prompt as `claude … --print … -p -`, meaning "read
 * the prompt from stdin" — so with stdin missing the agent is handed the
 * literal string `-` and asks what you want it to do. That is not a
 * misconfiguration of this harness; it is a broken contract, since
 * `IsolatedSandboxHandle.exec` documents that `stdin` MUST be piped to the
 * child. Every other provider honours it.
 *
 * The fix stays out of `node_modules`: write the stdin payload to a file inside
 * the sandbox and redirect the command from it. The command is wrapped in a
 * subshell so the redirection applies to the whole pipeline, not just its last
 * segment.
 *
 * Delete this the day the upstream provider pipes stdin itself.
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
      let payloadCount = 0;

      return {
        ...handle,
        exec: async (command, execOptions) => {
          if (execOptions?.stdin === undefined) return handle.exec(command, execOptions);

          const { stdin, ...rest } = execOptions;
          const name = `sandcastle-stdin-${process.pid}-${++payloadCount}`;
          const hostPath = join(tmpdir(), name);
          const sandboxPath = `/tmp/${name}`;

          await writeFile(hostPath, stdin, "utf8");
          try {
            await handle.copyIn(hostPath, sandboxPath);
          } finally {
            await rm(hostPath, { force: true });
          }

          return handle.exec(`( ${command} ) < ${sandboxPath}`, rest);
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
 * Fail before a sandbox is created rather than after, and fail with the fix in
 * the message: a missing token otherwise surfaces as an opaque SDK error, and a
 * leaked one surfaces as nothing at all.
 */
const assertVercelCredential = (): void => {
  if (envFileDefines(SANDBOX_ENV_FILE, "VERCEL_TOKEN")) {
    throw new Error(
      `${SANDBOX_ENV_FILE} defines VERCEL_TOKEN. Every key in that file is forwarded ` +
        `into the sandbox, so this would hand the agent a credential that can spend on ` +
        `your Vercel account. Move the line to ${HOST_ONLY_ENV_FILE} at the repository ` +
        `root, which stays on the host.`,
    );
  }

  if (process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN) return;

  throw new Error(
    `No Vercel credential. Put VERCEL_TOKEN in ${HOST_ONLY_ENV_FILE} at the repository ` +
      `root (see .env.example) — \`npm run sandcastle\` loads it on the host and never ` +
      `forwards it to the agent. Exporting it in your shell also works.`,
  );
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

/**
 * Phase one: implement the issue in a sandbox. Deliberately does no host git
 * work beyond what Sandcastle itself does on its own named branch, because the
 * whole wave runs concurrently against a single checkout.
 */
const implementIssue = async (issue: number, signal: AbortSignal): Promise<AgentRun> => {
  const branch = `agent/issue-${issue}`;
  if (branchExists(branch)) {
    throw new Error(
      `Branch ${branch} already exists from an earlier run. Sandcastle ignores ` +
        `baseBranch when the branch is already there, so this run would build on a ` +
        `stale ${BASE_BRANCH}. Inspect it, then delete it with \`git branch -D ${branch}\`.`,
    );
  }
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
    // One failure in a wave cancels its siblings rather than letting them keep
    // burning the month's compute budget.
    signal,
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
    waves.forEach((wave, index) => {
      const labelled = wave.map(
        (issue) => `#${issue}${REVIEW_BY_HUMAN.has(issue) ? " (draft, human review)" : " (auto-merge)"}`,
      );
      const halts = wave.some((issue) => REVIEW_BY_HUMAN.has(issue));
      console.log(`Wave ${index + 1}: ${labelled.join(", ")}${halts ? " — pipeline stops here" : ""}`);
    });
    return;
  }

  assertVercelCredential();

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

  for (const [index, wave] of waves.entries()) {
    const todo = wave.filter((issue) => !isClosed(issue));
    if (todo.length === 0) {
      console.log(`\n=== Wave ${index + 1}/${waves.length}: already done, skipping ===`);
      continue;
    }

    console.log(`\n=== Wave ${index + 1}/${waves.length}: ${todo.map((n) => `#${n}`).join(", ")} ===`);

    const controller = new AbortController();
    let agentRuns: AgentRun[];
    try {
      agentRuns = await Promise.all(
        todo.map((issue) => implementIssue(issue, controller.signal)),
      );
    } catch (error) {
      controller.abort();
      throw error;
    }

    // Serialized: each of these checks out branches and moves master.
    for (const agentRun of agentRuns) {
      await land(agentRun);
    }

    const awaitingReview = todo.filter((issue) => REVIEW_BY_HUMAN.has(issue));
    if (awaitingReview.length > 0) {
      console.log(
        `\nStopping: ${awaitingReview.map((n) => `#${n}`).join(", ")} ` +
          `${awaitingReview.length === 1 ? "is" : "are"} waiting on your review. ` +
          `Merge the draft PR${awaitingReview.length === 1 ? "" : "s"}, then run this again — ` +
          `later waves branch from ${BASE_BRANCH} and need that work landed first.`,
      );
      return;
    }
  }

  console.log("\nPipeline complete.");
};

await main();

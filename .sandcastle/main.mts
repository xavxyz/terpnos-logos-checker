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
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";
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
  const title = issueTitle(issue);
  log(issue, title);
  log(issue, `branch ${branch}, model ${MODEL}`);

  const result = await run({
    name: `issue-${issue}`,
    agent: claudeCode(MODEL),
    sandbox: vercel({
      timeout: SANDBOX_TIMEOUT_MS,
      resources: { vcpus: VCPUS },
      runtime: "node24",
    }),
    promptFile: `${process.cwd()}/.sandcastle/prompt.md`,
    // Substituted on the host before the !`…` expressions run, so the prompt's
    // own gh calls resolve against the same repo this script inferred.
    promptArgs: { ISSUE_NUMBER: issue, REPO },
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
              'sudo ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude || true',
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

  git("checkout", branch);

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

  if (git("status", "--porcelain") !== "") {
    throw new Error("Working tree is dirty. Commit or stash before running.");
  }

  git("fetch", "origin");
  git("checkout", BASE_BRANCH);
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

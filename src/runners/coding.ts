import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerContext, RunnerOutcome } from "../types.js";
import type { Hotcell, SandboxHandle } from "../hotcell.js";
import {
  ENSURE_OPENCODE,
  OPENCODE_SETUP,
  opencodeRunCommand,
  shellQuote,
} from "../hotcell.js";
import { publishBundle } from "../github.js";
import { artifactUrl } from "../files/links.js";

/**
 * Coding mission (see DESIGN.md "Coding missions" + "Thread cells"):
 *  1. reuse the thread's cell sandbox (ctx.cellSandbox) or create a fresh one
 *     with { repo, egress, spendCapUsd, sleepAfterMs, setup: [OPENCODE_SETUP] };
 *     ctx.registerSandbox(...) immediately either way.
 *  2. reused cell: make sure the repo is present (clone if missing, fetch if
 *     not — the workspace is the conversation's memory).
 *  3. write full prompt (persona + thread context + ask + "commit your work"
 *     contract) to /workspace/.mission/task.md
 *  4. run opencodeRunCommand; stream → keep tail as the agent's answer;
 *     save full transcript to <missionDir>/transcript.txt
 *  5. in-sandbox: commit leftovers on branch mission/<id>, bundle
 *     <clone-time HEAD>..HEAD
 *  6. bundle → host (readFileBinary) → <missionDir>/out.bundle
 *  7. publishBundle() (src/github.js) → push + PR via host gh
 *
 * The ENGINE owns usage accounting and sandbox lifecycle — the runner never
 * calls usage() or destroy(); it leaves the sandbox running.
 *
 * No changes made by the agent (empty bundle) is a *successful* mission with
 * a summary and no PR.
 */
export async function runCodingMission(
  ctx: RunnerContext,
  hotcell: Hotcell
): Promise<RunnerOutcome> {
  const { mission, agent, config, missionDir } = ctx;
  const repo = mission.repo;
  if (!repo) throw new Error("coding mission requires a repo URL");

  const repoName = repo.replace(/\.git$/, "").split("/").pop();
  if (!repoName || !/^[A-Za-z0-9._-]+$/.test(repoName)) {
    throw new Error(`cannot derive a safe repo name from "${repo}"`);
  }
  let repoDir = `/workspace/${repoName}`;
  const branch = `mission/${mission.id}`;
  const model = agent.model ?? config.defaultModel;

  bailIfCancelled(ctx);
  await ctx.setStatus(
    ctx.cellReused ? "picking up where we left off" : "setting up a fresh workspace"
  );
  const sandbox: SandboxHandle =
    ctx.cellSandbox ??
    (await hotcell.createSandbox({
      repo,
      egress: true,
      spendCapUsd: config.spendCapUsd,
      sleepAfterMs: config.sandboxSleepAfterMs,
      setup: [OPENCODE_SETUP],
    }));
  ctx.registerSandbox(sandbox);

  if (ctx.cellReused) {
    // The cell may predate this repo (research-first thread), already hold
    // THIS repo (refresh it), or hold a DIFFERENT repo that shares a basename
    // — in that last case clone under a url-hash suffix rather than silently
    // operating on the wrong repository. The script echoes the directory it
    // settled on; the egress gateway allowlists git forges.
    const altDir = `/workspace/${repoName}-${urlHash(repo)}`;
    const want = repo.replace(/\.git$/, "").replace(/\/+$/, "");
    const prep = await sandbox.exec(
      [
        `WANT=${shellQuote(want)}`,
        `matches() { CUR=$(git -C "$1" remote get-url origin 2>/dev/null || echo ""); CUR="\${CUR%.git}"; CUR="\${CUR%/}"; [ "$CUR" = "$WANT" ]; }`,
        `if [ -d ${shellQuote(`${repoDir}/.git`)} ] && matches ${shellQuote(repoDir)}; then`,
        `  git -C ${shellQuote(repoDir)} fetch origin --quiet || true`,
        `  echo "REPODIR=${repoDir}"`,
        `elif [ ! -d ${shellQuote(`${repoDir}/.git`)} ]; then`,
        `  git clone ${shellQuote(repo)} ${shellQuote(repoDir)}`,
        `  echo "REPODIR=${repoDir}"`,
        `else`,
        `  if [ -d ${shellQuote(`${altDir}/.git`)} ]; then`,
        `    git -C ${shellQuote(altDir)} fetch origin --quiet || true`,
        `  else`,
        `    git clone ${shellQuote(repo)} ${shellQuote(altDir)}`,
        `  fi`,
        `  echo "REPODIR=${altDir}"`,
        `fi`,
      ].join("\n")
    );
    if (prep.exitCode !== 0) {
      throw new Error(
        `workspace prep failed (exit ${prep.exitCode}): ` +
          tailOf(prep.stderr || prep.stdout, 400).trim()
      );
    }
    const resolved = prep.stdout.match(/^REPODIR=(.+)$/m)?.[1]?.trim();
    if (resolved) repoDir = resolved;
  }

  bailIfCancelled(ctx);
  const taskFile = "/workspace/.mission/task.md";
  await sandbox.exec("mkdir -p /workspace/.mission");
  await sandbox.writeFile(
    taskFile,
    buildTask(agent.persona, mission.prompt, repoDir, ctx.threadContext)
  );
  // HEAD as of mission start, recorded BEFORE the agent touches anything: the
  // exact base for "did it change something?" and for the bundle range —
  // immune to origin/HEAD being unset or the default branch not being "main".
  const initialSha = await headSha(sandbox, repoDir);

  // Create-time setup is best-effort/async — guarantee the tool is actually
  // there (a fresh sandbox's install takes ~30s) before invoking it.
  const ensure = await sandbox.exec(ENSURE_OPENCODE);
  if (ensure.exitCode !== 0) {
    throw new Error(
      `couldn't install opencode in the sandbox: ` +
        tailOf(ensure.stderr || ensure.stdout, 400).trim()
    );
  }

  await ctx.setStatus("working on it — this can take a few minutes");
  const run = await sandbox.execStreaming(
    opencodeRunCommand({ dir: repoDir, model, taskFile })
  );
  const cleanStdout = cleanOutput(run.stdout);
  const cleanStderr = cleanOutput(run.stderr);
  await writeFile(
    join(missionDir, "transcript.txt"),
    cleanStderr
      ? `${cleanStdout}\n\n--- stderr ---\n${cleanStderr}\n`
      : `${cleanStdout}\n`
  );
  if (run.exitCode !== 0) {
    throw new Error(
      `opencode exited ${run.exitCode}: ` +
        tailOf(cleanStderr || cleanStdout, 400).trim()
    );
  }
  const answer = tailOf(cleanStdout, 1500).trim();

  bailIfCancelled(ctx);
  await ctx.setStatus("packaging the changes");
  const post = await sandbox.exec(
    postRunScript(repoDir, mission.id, agent.name, branch, initialSha)
  );
  if (post.exitCode !== 0) {
    throw new Error(
      `post-run commit/bundle failed (exit ${post.exitCode}): ` +
        tailOf(post.stderr || post.stdout, 400).trim()
    );
  }
  const bundled = /^BUNDLED$/m.test(post.stdout);
  const noChanges = /^NO_CHANGES$/m.test(post.stdout);
  if (!bundled && !noChanges) {
    throw new Error(
      `post-run script produced no marker: ${tailOf(post.stdout, 300).trim()}`
    );
  }

  const files: string[] = [];
  let bundlePath: string | null = null;
  let baseBranch = "main";
  if (bundled) {
    baseBranch = post.stdout.match(/^BASE=(.+)$/m)?.[1]?.trim() || "main";
    await ctx.setStatus("collecting the work");
    const buf = await sandbox.readFileBinary("/workspace/.mission/out.bundle");
    bundlePath = join(missionDir, "out.bundle");
    await writeFile(bundlePath, buf);
    files.push("out.bundle");
  }

  let summary: string;
  let prUrl: string | undefined;
  let pushedBranch: string | undefined;

  if (!bundled) {
    summary =
      `${answer || "(no output)"}\n\n` +
      `_(no code changes were made — nothing to push)_`;
  } else {
    bailIfCancelled(ctx);
    await ctx.setStatus("opening the pull request");
    let publishError: string | undefined;
    try {
      const workDir = await mkdtemp(join(tmpdir(), "groundcontrol-"));
      const published = await publishBundle({
        repo,
        bundlePath: bundlePath as string,
        branch,
        baseBranch,
        title: `mission ${mission.id}: ${headOf(mission.prompt, 60)}`,
        body:
          `${mission.prompt}\n\n---\n` +
          `work by agent "${agent.name}" via groundcontrol · mission ${mission.id}`,
        ghPath: config.ghPath,
        workDir,
      });
      prUrl = published.prUrl;
      if (published.pushed) pushedBranch = published.branch;
      publishError = published.error;
    } catch (err) {
      publishError = err instanceof Error ? err.message : String(err);
    }

    // The PR / branch link is rendered by fmtResult from result.prUrl and
    // result.branch — the summary stays the agent's own words.
    if (prUrl) {
      summary = answer || "(no output)";
    } else if (pushedBranch) {
      summary =
        `${answer || "(no output)"}\n\n` +
        `⚠️ I pushed the branch but couldn't open the PR` +
        `${publishError ? `: ${publishError}` : ""}.`;
    } else {
      // The bundle is on disk — the work is preserved, so the mission still
      // succeeds even though publishing failed.
      summary =
        `${answer || "(no output)"}\n\n` +
        `⚠️ publishing failed${publishError ? `: ${publishError}` : ""} — ` +
        `the work is preserved as \`out.bundle\` in the mission folder.`;
    }
  }

  await writeFile(join(missionDir, "summary.md"), `${summary}\n`);
  const allFiles = ["summary.md", "transcript.txt", ...files];
  return {
    result: {
      summary,
      prUrl,
      branch: pushedBranch,
      files: allFiles,
      links: linksFor(config.publicBaseUrl, mission.id, allFiles),
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function bailIfCancelled(ctx: RunnerContext): void {
  if (ctx.isCancelled()) throw new Error("cancelled");
}

/**
 * Full task prompt: persona + recent thread conversation (pre-capped by the
 * poster, included verbatim) + the owner's ask + the output contract.
 */
function buildTask(
  persona: string | undefined,
  prompt: string,
  repoDir: string,
  threadContext: string | null
): string {
  const parts: string[] = [];
  if (persona) parts.push(persona.trim());
  if (threadContext) parts.push(`# Conversation so far\n\n${threadContext}`);
  parts.push(`# Task\n\n${prompt.trim()}`);
  parts.push(
    `# Output contract\n\n` +
      `- Implement the requested change in this repository (${repoDir}).\n` +
      `- If the project has tests, run them and make them pass.\n` +
      `- COMMIT all of your work with clear, descriptive commit messages ` +
      `(git add + git commit). Uncommitted work may be lost.\n` +
      `- Do not push; the host publishes your commits.\n` +
      `- This workspace persists across this conversation — earlier missions' ` +
      `work may already be here, and yours stays for follow-ups.`
  );
  return parts.join("\n\n") + "\n";
}

/** Mission-start HEAD sha of the repo inside the sandbox ("" when undeterminable). */
async function headSha(
  sandbox: SandboxHandle,
  repoDir: string
): Promise<string> {
  try {
    const r = await sandbox.exec(
      `git -C ${shellQuote(repoDir)} rev-parse HEAD`
    );
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

/**
 * One in-sandbox script: git identity, detect the default-branch NAME (for the
 * PR base — symbolic-ref, then ls-remote when origin/HEAD is unset), move work
 * to mission/<id>, commit leftovers, and bundle everything past the recorded
 * mission-start HEAD (falling back to origin/BASE when that sha is unavailable).
 * Emits BUNDLED + BASE=<base>, or NO_CHANGES, on stdout.
 */
function postRunScript(
  repoDir: string,
  missionId: string,
  agentName: string,
  branch: string,
  initialSha: string
): string {
  const email = `${agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}@users.noreply.github.com`;
  return [
    `set -e`,
    `cd ${shellQuote(repoDir)}`,
    `git config user.email ${shellQuote(email)}`,
    `git config user.name ${shellQuote(agentName)}`,
    // Default-branch NAME (PR base). origin/HEAD is often unset in scripted
    // clones — fall back to asking the remote directly.
    `BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)`,
    `BASE=\${BASE#origin/}`,
    `if [ -z "$BASE" ]; then`,
    `  BASE=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\\(.*\\)[[:space:]]HEAD$|\\1|p' | head -1)`,
    `fi`,
    `[ -n "$BASE" ] || BASE=main`,
    `git checkout -B ${shellQuote(branch)}`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m ${shellQuote(
      `mission ${missionId}: uncommitted agent work`
    )}`,
    // Change detection uses the recorded mission-start sha: exact regardless
    // of branch naming; origin/$BASE is only a fallback.
    `FROM=${shellQuote(initialSha)}`,
    `git cat-file -e "$FROM" 2>/dev/null || FROM="origin/$BASE"`,
    // The BUNDLE ranges from the fork point with the base branch: a bundle
    // whose prerequisite is a previous mission's unmerged branch tip could
    // never be imported by the host's base-only clone, so stacked follow-ups
    // in a thread would fail to publish forever.
    `BFROM=$(git merge-base HEAD "origin/$BASE" 2>/dev/null || true)`,
    `[ -n "$BFROM" ] || BFROM="$FROM"`,
    `if [ "$(git rev-list --count "$FROM..HEAD" 2>/dev/null || echo 0)" -gt 0 ]; then`,
    `  mkdir -p /workspace/.mission`,
    `  git bundle create /workspace/.mission/out.bundle "$BFROM..${branch}"`,
    `  echo BUNDLED`,
    `  echo "BASE=$BASE"`,
    `else`,
    `  echo NO_CHANGES`,
    `fi`,
  ].join("\n");
}

/** Public tailnet links parallel to `files`, or undefined when unconfigured. */
function linksFor(
  publicBaseUrl: string | undefined,
  missionId: string,
  files: string[]
): string[] | undefined {
  if (!publicBaseUrl) return undefined;
  const links: string[] = [];
  for (const f of files) {
    const url = artifactUrl(publicBaseUrl, missionId, f);
    if (url) links.push(url);
  }
  return links;
}

// Matches ANSI escape/control sequences (the standard ansi-regex pattern).
const ANSI_RE =
  /[][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;

/** Strip ANSI sequences and normalize carriage returns. */
function cleanOutput(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function tailOf(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

function headOf(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n).trimEnd()}…`;
}

/** Short stable suffix distinguishing same-basename repos in one workspace. */
function urlHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

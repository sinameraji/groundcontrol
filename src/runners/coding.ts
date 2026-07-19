import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerContext, RunnerOutcome } from "../types.js";
import type { Hotcell, SandboxHandle } from "../hotcell.js";
import { OPENCODE_SETUP, opencodeRunCommand, shellQuote } from "../hotcell.js";
import { publishBundle } from "../github.js";
import { artifactUrl } from "../files/links.js";

/**
 * Coding mission (see DESIGN.md "Coding missions"):
 *  1. sandbox with { repo, egress, spendCapUsd, setup: [OPENCODE_SETUP] };
 *     ctx.registerSandbox(...) immediately.
 *  2. write full prompt (persona + ask + "commit your work" contract) to
 *     /workspace/.mission/task.md
 *  3. run opencodeRunCommand; stream → keep tail as the agent's answer;
 *     save full transcript to <missionDir>/transcript.txt
 *  4. in-sandbox: commit leftovers on branch mission/<id>, bundle
 *     <defaultBranch>..HEAD
 *  5. bundle → host (readFileBinary) → <missionDir>/out.bundle
 *  6. publishBundle() (src/github.js) → push + PR via host gh
 *  7. usage() BEFORE destroy; destroy in finally.
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
  if (!repoName) throw new Error(`cannot derive a repo name from "${repo}"`);
  const repoDir = `/workspace/${repoName}`;
  const branch = `mission/${mission.id}`;
  const model = agent.model ?? config.defaultModel;

  bailIfCancelled(ctx);
  await ctx.setStatus("creating sandbox");
  const sandbox: SandboxHandle = await hotcell.createSandbox({
    repo,
    egress: true,
    spendCapUsd: config.spendCapUsd,
    setup: [OPENCODE_SETUP],
  });
  ctx.registerSandbox(sandbox);

  let usage: { tokens: number; costUsd: number } | null = null;
  try {
    bailIfCancelled(ctx);
    const taskFile = "/workspace/.mission/task.md";
    await sandbox.exec("mkdir -p /workspace/.mission");
    await sandbox.writeFile(
      taskFile,
      buildTask(agent.persona, mission.prompt, repoDir)
    );
    // Clone-time HEAD, recorded BEFORE the agent touches anything: the exact
    // base for "did it change something?" and for the bundle range — immune to
    // origin/HEAD being unset or the default branch not being "main".
    const initialSha = await headSha(sandbox, repoDir);

    await ctx.setStatus("agent working");
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
    await ctx.setStatus("committing & bundling");
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
      await ctx.setStatus("retrieving bundle");
      const buf = await sandbox.readFileBinary("/workspace/.mission/out.bundle");
      bundlePath = join(missionDir, "out.bundle");
      await writeFile(bundlePath, buf);
      files.push("out.bundle");
    }

    // All sandbox work is done: snapshot cost, then free the sandbox early
    // (the finally below tolerates the double destroy).
    usage = await hotcell.usage(sandbox.id);
    await sandbox.destroy().catch(() => {});

    let summary: string;
    let prUrl: string | undefined;
    let pushedBranch: string | undefined;

    if (!bundled) {
      summary =
        `${agent.name} made no commits — nothing to push, no PR opened.\n\n` +
        `agent's answer:\n${answer || "(no output)"}`;
    } else {
      bailIfCancelled(ctx);
      await ctx.setStatus("publishing PR");
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

      if (prUrl) {
        summary = `PR opened: ${prUrl}\n\n${answer || "(no output)"}`;
      } else if (pushedBranch) {
        summary =
          `branch ${pushedBranch} pushed, but the PR step failed` +
          `${publishError ? `: ${publishError}` : ""}.\n\n` +
          `${answer || "(no output)"}`;
      } else {
        // The bundle is on disk — the work is preserved, so the mission still
        // succeeds even though publishing failed.
        summary =
          `publishing failed${publishError ? `: ${publishError}` : ""} — ` +
          `the work is preserved in out.bundle in the mission folder.\n\n` +
          `${answer || "(no output)"}`;
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
      costUsd: usage?.costUsd,
      tokens: usage?.tokens,
    };
  } finally {
    await sandbox.destroy().catch(() => {});
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function bailIfCancelled(ctx: RunnerContext): void {
  if (ctx.isCancelled()) throw new Error("cancelled");
}

/** Full task prompt: persona + the owner's ask + the output contract. */
function buildTask(
  persona: string | undefined,
  prompt: string,
  repoDir: string
): string {
  const parts: string[] = [];
  if (persona) parts.push(persona.trim());
  parts.push(`# Task\n\n${prompt.trim()}`);
  parts.push(
    `# Output contract\n\n` +
      `- Implement the requested change in this repository (${repoDir}).\n` +
      `- If the project has tests, run them and make them pass.\n` +
      `- COMMIT all of your work with clear, descriptive commit messages ` +
      `(git add + git commit). Uncommitted work may be lost.\n` +
      `- Do not push; the host publishes your commits.`
  );
  return parts.join("\n\n") + "\n";
}

/** Clone-time HEAD sha of the repo inside the sandbox ("" when undeterminable). */
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
 * clone-time HEAD (falling back to origin/BASE when that sha is unavailable).
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
    // Change detection + bundle range prefer the recorded clone-time sha:
    // exact regardless of branch naming; origin/$BASE is only a fallback.
    `FROM=${shellQuote(initialSha)}`,
    `git cat-file -e "$FROM" 2>/dev/null || FROM="origin/$BASE"`,
    `if [ "$(git rev-list --count "$FROM..HEAD" 2>/dev/null || echo 0)" -gt 0 ]; then`,
    `  mkdir -p /workspace/.mission`,
    `  git bundle create /workspace/.mission/out.bundle "$FROM..${branch}"`,
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
  /[][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;

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

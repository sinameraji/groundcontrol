import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { RunnerContext, RunnerOutcome } from "../types.js";
import type { Hotcell, SandboxHandle } from "../hotcell.js";
import { OPENCODE_SETUP, opencodeRunCommand, shellQuote } from "../hotcell.js";
import { artifactUrl } from "../files/links.js";

/** Where the task contract tells the agent to leave its artifacts. */
const OUT_DIR = "/workspace/out";

/**
 * Archive a reused cell's previous /workspace/out into /workspace/history/
 * (timestamped) so this mission starts with a clean out dir but the
 * conversation's earlier reports stay consultable. Fixed string — nothing
 * interpolated.
 */
const ARCHIVE_OUT_CMD =
  `if [ -d /workspace/out ] && [ -n "$(ls -A /workspace/out 2>/dev/null)" ]; then ` +
  `mkdir -p /workspace/history && ` +
  `mv /workspace/out "/workspace/history/$(date +%Y%m%d-%H%M%S)"; fi; ` +
  `mkdir -p /workspace/out`;

/**
 * Research mission (see DESIGN.md "Research missions" + "Thread cells"):
 *  1. reuse the thread's cell sandbox (ctx.cellSandbox) or create a fresh one
 *     with { egress, spendCapUsd, sleepAfterMs, setup: [OPENCODE_SETUP] }
 *     (no repo); ctx.registerSandbox(...) immediately either way.
 *  2. reused cell: archive the previous /workspace/out into
 *     /workspace/history/<timestamp>/ before anything else.
 *  3. prompt contract: full report → /workspace/out/report.md,
 *     ≤900-char summary → /workspace/out/summary.md, extras in /workspace/out/
 *  4. run opencodeRunCommand with dir=/workspace; transcript saved.
 *  5. copy everything under /workspace/out/ into <missionDir>/ (binary-safe).
 *  6. result.files = relative artifact paths, result.links via
 *     artifactUrl(); result.summary = summary.md if present, else answer tail.
 *
 * The ENGINE owns usage accounting and sandbox lifecycle — the runner never
 * calls usage() or destroy(); it leaves the sandbox running.
 *
 * A run that produced no /workspace/out/report.md still succeeds if OpenCode
 * exited 0 — the answer tail becomes the summary (saved as answer.md).
 */
export async function runResearchMission(
  ctx: RunnerContext,
  hotcell: Hotcell
): Promise<RunnerOutcome> {
  const { mission, agent, config, missionDir } = ctx;
  const model = agent.model ?? config.defaultModel;

  bailIfCancelled(ctx);
  await ctx.setStatus(
    ctx.cellReused ? "picking up where we left off" : "setting up a fresh workspace"
  );
  const sandbox: SandboxHandle =
    ctx.cellSandbox ??
    (await hotcell.createSandbox({
      egress: true,
      spendCapUsd: config.spendCapUsd,
      sleepAfterMs: config.sandboxSleepAfterMs,
      setup: [OPENCODE_SETUP],
    }));
  ctx.registerSandbox(sandbox);

  bailIfCancelled(ctx);
  if (ctx.cellReused) await sandbox.exec(ARCHIVE_OUT_CMD);

  const taskFile = "/workspace/.mission/task.md";
  await sandbox.exec(`mkdir -p /workspace/.mission ${OUT_DIR}`);
  await sandbox.writeFile(
    taskFile,
    buildTask(agent.persona, mission.prompt, ctx.threadContext)
  );

  await ctx.setStatus("digging in — this can take a few minutes");
  const run = await sandbox.execStreaming(
    opencodeRunCommand({ dir: "/workspace", model, taskFile })
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
  await ctx.setStatus("writing up the results");
  // A missing/empty out dir is fine — find's exit code is ignored on purpose.
  const found = await sandbox.exec(
    `find ${shellQuote(OUT_DIR)} -type f 2>/dev/null || true`
  );
  const copied: string[] = [];
  let summaryText = "";
  for (const raw of found.stdout.split("\n")) {
    if (!raw) continue;
    const rel = outRelPath(raw);
    if (rel === null) continue; // escapes /workspace/out — reject
    const hostPath = resolve(missionDir, rel);
    if (!hostPath.startsWith(resolve(missionDir) + sep)) continue; // reject
    await mkdir(dirname(hostPath), { recursive: true });
    const buf = await sandbox.readFileBinary(`${OUT_DIR}/${rel}`);
    await writeFile(hostPath, buf);
    copied.push(rel);
    if (rel === "summary.md") summaryText = buf.toString("utf8").trim();
  }

  const files = [...copied, "transcript.txt"];
  let summary: string;
  if (summaryText) {
    summary = summaryText;
  } else {
    summary = answer || "(no output)";
    await writeFile(join(missionDir, "answer.md"), `${summary}\n`);
    files.push("answer.md");
  }

  return {
    result: {
      summary,
      files,
      links: linksFor(config.publicBaseUrl, mission.id, files),
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
  threadContext: string | null
): string {
  const parts: string[] = [];
  if (persona) parts.push(persona.trim());
  if (threadContext) parts.push(`# Conversation so far\n\n${threadContext}`);
  parts.push(`# Task\n\n${prompt.trim()}`);
  parts.push(
    `# Output contract\n\n` +
      `- Write your full report (Markdown) to ${OUT_DIR}/report.md.\n` +
      `- Write a summary of AT MOST 900 characters to ${OUT_DIR}/summary.md.\n` +
      `- Put any extra artifacts (data, tables, scripts) under ${OUT_DIR}/.\n` +
      `- Only files under ${OUT_DIR}/ are collected; anything else is lost.\n` +
      `- This workspace persists across this conversation — ` +
      `/workspace/history/ holds earlier missions' outputs, which you may ` +
      `consult when the ask builds on them.`
  );
  return parts.join("\n\n") + "\n";
}

/**
 * Sandbox path (a `find` output line — sandbox-controlled, treat as hostile) →
 * artifact path relative to /workspace/out, or null when the normalized path
 * is not strictly inside it.
 */
function outRelPath(p: string): string | null {
  const norm = posix.normalize(p);
  if (!norm.startsWith(`${OUT_DIR}/`)) return null;
  const rel = norm.slice(OUT_DIR.length + 1);
  return rel.length > 0 ? rel : null;
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

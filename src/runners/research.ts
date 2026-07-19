import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { RunnerContext, RunnerOutcome } from "../types.js";
import type { Hotcell, SandboxHandle } from "../hotcell.js";
import { OPENCODE_SETUP, opencodeRunCommand, shellQuote } from "../hotcell.js";
import { artifactUrl } from "../files/links.js";

/** Where the task contract tells the agent to leave its artifacts. */
const OUT_DIR = "/workspace/out";

/**
 * Research mission (see DESIGN.md "Research missions"):
 *  1. sandbox with { egress, spendCapUsd, setup: [OPENCODE_SETUP] } (no repo);
 *     ctx.registerSandbox(...) immediately.
 *  2. prompt contract: full report → /workspace/out/report.md,
 *     ≤900-char summary → /workspace/out/summary.md, extras in /workspace/out/
 *  3. run opencodeRunCommand with dir=/workspace; transcript saved.
 *  4. copy everything under /workspace/out/ into <missionDir>/ (binary-safe).
 *  5. result.files = relative artifact paths, result.links via
 *     artifactUrl(); result.summary = summary.md if present, else answer tail.
 *  6. usage() BEFORE destroy; destroy in finally.
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
  await ctx.setStatus("creating sandbox");
  const sandbox: SandboxHandle = await hotcell.createSandbox({
    egress: true,
    spendCapUsd: config.spendCapUsd,
    setup: [OPENCODE_SETUP],
  });
  ctx.registerSandbox(sandbox);

  let usage: { tokens: number; costUsd: number } | null = null;
  try {
    bailIfCancelled(ctx);
    const taskFile = "/workspace/.mission/task.md";
    await sandbox.exec(`mkdir -p /workspace/.mission ${OUT_DIR}`);
    await sandbox.writeFile(taskFile, buildTask(agent.persona, mission.prompt));

    await ctx.setStatus("agent working");
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
    await ctx.setStatus("collecting artifacts");
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

    // All sandbox work is done: snapshot cost, then free the sandbox early
    // (the finally below tolerates the double destroy).
    usage = await hotcell.usage(sandbox.id);
    await sandbox.destroy().catch(() => {});

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
function buildTask(persona: string | undefined, prompt: string): string {
  const parts: string[] = [];
  if (persona) parts.push(persona.trim());
  parts.push(`# Task\n\n${prompt.trim()}`);
  parts.push(
    `# Output contract\n\n` +
      `- Write your full report (Markdown) to ${OUT_DIR}/report.md.\n` +
      `- Write a summary of AT MOST 900 characters to ${OUT_DIR}/summary.md.\n` +
      `- Put any extra artifacts (data, tables, scripts) under ${OUT_DIR}/.\n` +
      `- Only files under ${OUT_DIR}/ are collected; anything else is lost.`
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
  /[][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;

/** Strip ANSI sequences and normalize carriage returns. */
function cleanOutput(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function tailOf(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

import { execFile } from "node:child_process";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { Hotcell } from "./hotcell.js";
import { ThreadCells } from "./missions/cells.js";
import type { Config, JanitorReport, ThreadCell } from "./types.js";

const execFileP = promisify(execFile);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Weekly cleanup (see DESIGN.md "Capacity & safety rails"):
 *  - `docker system prune -f` via execFile (dangling layers only — never -a);
 *    a missing docker binary is a note in the report, not a failure
 *  - walk <artifactsRoot>/<mission-id>/ recursively; delete files whose size
 *    exceeds janitor.maxArtifactMb AND whose mtime is older than
 *    janitor.artifactMaxAgeDays. state.json is never deleted regardless.
 *  - small artifacts are kept forever (the mission history is the point)
 *  - destroy thread cells idle longer than janitor.cellMaxIdleDays and prune
 *    their threads.json mappings (DESIGN.md "Thread cells" step 5)
 *  - dryRun: report what WOULD be deleted, delete nothing
 *  - never follow symlinks; never touch anything outside artifactsRoot
 */
export async function runJanitor(
  cfg: Config,
  opts?: {
    dockerPath?: string;
    now?: Date;
    dryRun?: boolean;
    /** Test seam — defaults to the ThreadCells store under artifactsRoot. */
    cells?: {
      list(): Promise<ThreadCell[]>;
      remove(id: string): Promise<void>;
    };
    /** Test seam — defaults to Hotcell's best-effort destroySandbox. */
    destroySandbox?: (id: string) => Promise<void>;
    /** Test seam — defaults to Hotcell.listInfo (null = daemon unreachable). */
    listSandboxes?: () => Promise<Array<{ id: string; status: string }> | null>;
  }
): Promise<JanitorReport> {
  const report: JanitorReport = { prunedFiles: [], freedBytes: 0, errors: [] };
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const dockerPath = opts?.dockerPath ?? "docker";
  const cells = opts?.cells ?? new ThreadCells(cfg.artifactsRoot);
  let hotcell: Hotcell | null = null;
  const destroySandbox =
    opts?.destroySandbox ??
    ((id: string) => (hotcell ??= new Hotcell(cfg)).destroySandbox(id));
  const listSandboxes =
    opts?.listSandboxes ?? (() => (hotcell ??= new Hotcell(cfg)).listInfo());

  // Docker prune — deletes dangling layers, so a dry run skips it entirely.
  if (dryRun) {
    report.dockerPruneOutput = "skipped (dry run)";
  } else {
    try {
      const { stdout } = await execFileP(
        dockerPath,
        ["system", "prune", "-f"],
        { maxBuffer: 16 * 1024 * 1024 }
      );
      report.dockerPruneOutput = stdout.trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        report.errors.push("docker not found (skipped)");
      } else {
        report.errors.push(`docker prune failed: ${errMessage(err)}`);
      }
    }
  }

  const maxBytes = cfg.janitor.maxArtifactMb * 1024 * 1024;
  const cutoffMs =
    now.getTime() - cfg.janitor.artifactMaxAgeDays * 24 * 60 * 60 * 1000;

  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      report.errors.push(`readdir ${dir}: ${errMessage(err)}`);
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch (err) {
        report.errors.push(`lstat ${full}: ${errMessage(err)}`);
        continue;
      }
      // Never follow (or delete) symlinks — they can point anywhere.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (name === "state.json") continue;
      if (st.size <= maxBytes || st.mtimeMs >= cutoffMs) continue;
      if (!dryRun) {
        try {
          await unlink(full);
        } catch (err) {
          report.errors.push(`unlink ${full}: ${errMessage(err)}`);
          continue;
        }
      }
      report.prunedFiles.push(relative(cfg.artifactsRoot, full));
      report.freedBytes += st.size;
    }
  };

  // Missing artifactsRoot → nothing to walk (cells are still considered).
  try {
    const top = await readdir(cfg.artifactsRoot, { withFileTypes: true });
    for (const entry of top) {
      // Only mission directories are walked; stray top-level files are kept.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      await walk(join(cfg.artifactsRoot, entry.name));
    }
  } catch {
    /* no artifacts to prune */
  }

  // Thread-cell reaping (DESIGN.md "Thread cells" step 5): destroy cells idle
  // longer than janitor.cellMaxIdleDays, then prune their mappings. An
  // unparseable lastUsedAt counts as expired — a corrupt record must not pin
  // a sandbox forever. dryRun reports would-be reaps without acting.
  report.reapedCells = [];
  const idleCutoffMs =
    now.getTime() - cfg.janitor.cellMaxIdleDays * 24 * 60 * 60 * 1000;
  let allCells: ThreadCell[];
  try {
    allCells = await cells.list();
  } catch (err) {
    report.errors.push(`cells list: ${errMessage(err)}`);
    allCells = [];
  }
  // Never reap a cell whose sandbox is RUNNING right now — the engine stamps
  // lastUsedAt at mission start, but this is the belt to that suspender (a
  // mission started seconds before the sweep, a stamp write that failed).
  const running = new Set(
    ((await listSandboxes()) ?? [])
      .filter((s) => s.status === "running")
      .map((s) => s.id)
  );
  for (const cell of allCells) {
    if (running.has(cell.sandboxId)) continue;
    const lastUsedMs = Date.parse(cell.lastUsedAt);
    if (Number.isFinite(lastUsedMs) && lastUsedMs >= idleCutoffMs) continue;
    if (!dryRun) {
      try {
        await destroySandbox(cell.sandboxId);
        await cells.remove(cell.threadId);
      } catch (err) {
        report.errors.push(`reap cell ${cell.threadId}: ${errMessage(err)}`);
        continue;
      }
    }
    report.reapedCells.push(cell.threadId);
  }

  return report;
}

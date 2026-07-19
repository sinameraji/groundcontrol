import { execFile } from "node:child_process";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Config, JanitorReport } from "./types.js";

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
 *  - dryRun: report what WOULD be deleted, delete nothing
 *  - never follow symlinks; never touch anything outside artifactsRoot
 */
export async function runJanitor(
  cfg: Config,
  opts?: { dockerPath?: string; now?: Date; dryRun?: boolean }
): Promise<JanitorReport> {
  const report: JanitorReport = { prunedFiles: [], freedBytes: 0, errors: [] };
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const dockerPath = opts?.dockerPath ?? "docker";

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

  // Missing artifactsRoot → empty artifact report, not a throw.
  let top;
  try {
    top = await readdir(cfg.artifactsRoot, { withFileTypes: true });
  } catch {
    return report;
  }
  for (const entry of top) {
    // Only mission directories are walked; stray top-level files are kept.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    await walk(join(cfg.artifactsRoot, entry.name));
  }

  return report;
}

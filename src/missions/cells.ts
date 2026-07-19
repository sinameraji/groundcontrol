import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadCell } from "../types.js";

/**
 * Persistent threadId → cell (long-lived sandbox) mapping, stored as one
 * atomic JSON file at <root>/threads.json. Small (one entry per active
 * conversation), loaded on demand, written with temp-file + rename like the
 * mission store. Corrupt or missing files are treated as empty — the daemon's
 * sandbox list is the source of truth; this map is just the address book.
 */
export class ThreadCells {
  private readonly file: string;
  /** In-process mutation chain: upsert/remove are read-modify-write cycles on
   *  one shared file — interleaving them (e.g. two missions settling at once)
   *  would lose updates, so every mutation queues behind the previous one. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.file = join(root, "threads.json");
  }

  async get(threadId: string): Promise<ThreadCell | null> {
    const all = await this.readAll();
    return all[threadId] ?? null;
  }

  async list(): Promise<ThreadCell[]> {
    return Object.values(await this.readAll());
  }

  /** Insert or replace a cell record (keyed by its threadId). */
  upsert(cell: ThreadCell): Promise<void> {
    return this.mutate(async () => {
      const all = await this.readAll();
      all[cell.threadId] = cell;
      await this.writeAll(all);
    });
  }

  /** Remove a mapping (the sandbox itself is destroyed by the caller). */
  remove(threadId: string): Promise<void> {
    return this.mutate(async () => {
      const all = await this.readAll();
      if (!(threadId in all)) return;
      delete all[threadId];
      await this.writeAll(all);
    });
  }

  /** Reverse lookup — is this sandbox some thread's cell? */
  async findBySandbox(sandboxId: string): Promise<ThreadCell | null> {
    const all = await this.readAll();
    for (const cell of Object.values(all)) {
      if (cell.sandboxId === sandboxId) return cell;
    }
    return null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async readAll(): Promise<Record<string, ThreadCell>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: Record<string, ThreadCell> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (isCell(v)) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async writeAll(all: Record<string, ThreadCell>): Promise<void> {
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }
}

function isCell(v: unknown): v is ThreadCell {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c["threadId"] === "string" &&
    typeof c["sandboxId"] === "string" &&
    typeof c["lastUsedAt"] === "string"
  );
}

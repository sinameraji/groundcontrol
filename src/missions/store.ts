import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MissionRecord } from "../types.js";

/** Strict shape for ids that end up in paths, branch names, and URLs. */
const MISSION_ID_RE = /^m-[a-z0-9-]+$/;

/**
 * Mission id: "m-YYYYMMDD-xxxx" (4 hex chars of randomness). [a-z0-9-] only —
 * these ids are used in filesystem paths, git branch names, and URLs.
 */
export function newMissionId(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const mo = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `m-${y}${mo}${d}-${randomBytes(2).toString("hex")}`;
}

/** Minimal shape check so junk state.json files are treated as unparseable. */
function isMissionRecord(v: unknown): v is MissionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["status"] === "string" &&
    typeof r["createdAt"] === "string"
  );
}

/**
 * Persistence for missions. Layout: <root>/<mission-id>/state.json plus
 * whatever artifacts runners drop in the folder. The folder IS the durable
 * record; there is no other database.
 */
export class MissionStore {
  constructor(private readonly root: string) {}

  /** Absolute path of a mission's folder. Rejects ids not matching m-[a-z0-9-]+. */
  missionDir(id: string): string {
    if (!MISSION_ID_RE.test(id)) {
      throw new Error(`invalid mission id: ${JSON.stringify(id)}`);
    }
    return resolve(this.root, id);
  }

  /**
   * Allocate id + folder, write initial state.json with status "queued" and
   * createdAt now. `init` carries everything caller-known (agentName, type,
   * prompt, repo?, channelId, requesterId is not persisted).
   */
  async create(
    init: Omit<MissionRecord, "id" | "status" | "createdAt">
  ): Promise<MissionRecord> {
    await mkdir(this.root, { recursive: true });
    const id = await this.allocateDir();
    const record: MissionRecord = {
      ...init,
      id,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    await this.save(record);
    return record;
  }

  /** Atomically overwrite <dir>/state.json (write temp + rename). */
  async save(m: MissionRecord): Promise<void> {
    const dir = this.missionDir(m.id);
    const tmp = join(dir, `.state.json.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(m, null, 2) + "\n", "utf8");
    await rename(tmp, join(dir, "state.json"));
  }

  async load(id: string): Promise<MissionRecord | null> {
    const file = join(this.missionDir(id), "state.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      return isMissionRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** All missions, newest first (by createdAt). Tolerates junk folders. */
  async list(): Promise<MissionRecord[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const records: MissionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !MISSION_ID_RE.test(entry.name)) continue;
      const record = await this.load(entry.name);
      if (record !== null) records.push(record);
    }
    // ISO 8601 UTC timestamps compare correctly as strings; newest first.
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }

  /**
   * Boot-time sweep: any mission still "queued"/"running" (orchestrator died
   * mid-flight) becomes "failed" with error "orphaned by restart". Returns
   * the missions that were marked.
   */
  async markOrphans(): Promise<MissionRecord[]> {
    const marked: MissionRecord[] = [];
    for (const m of await this.list()) {
      if (m.status !== "queued" && m.status !== "running") continue;
      m.status = "failed";
      m.error = "orphaned by restart";
      m.finishedAt = new Date().toISOString();
      await this.save(m);
      marked.push(m);
    }
    return marked;
  }

  /** Create a fresh mission folder, retrying on the (rare) id collision. */
  private async allocateDir(): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = newMissionId();
      try {
        await mkdir(this.missionDir(id));
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
    throw new Error("could not allocate a unique mission id");
  }
}

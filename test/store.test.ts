import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionStore, newMissionId } from "../src/missions/store.js";
import type { MissionRecord } from "../src/types.js";

const baseInit = {
  agentName: "codey",
  type: "coding" as const,
  prompt: "add rate limiting",
  channelId: "chan-1",
};

describe("newMissionId", () => {
  it("matches m-YYYYMMDD-xxxx with 4 hex chars", () => {
    expect(newMissionId()).toMatch(/^m-\d{8}-[0-9a-f]{4}$/);
  });

  it("embeds the given date (UTC)", () => {
    const id = newMissionId(new Date(Date.UTC(2026, 6, 19, 12, 0, 0)));
    expect(id.startsWith("m-20260719-")).toBe(true);
  });

  it("varies the random suffix", () => {
    const ids = new Set(Array.from({ length: 8 }, () => newMissionId()));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("MissionStore", () => {
  let root: string;
  let store: MissionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gc-store-"));
    store = new MissionStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("create writes a queued state.json in the mission folder", async () => {
    const m = await store.create(baseInit);
    expect(m.id).toMatch(/^m-\d{8}-[0-9a-f]{4}$/);
    expect(m.status).toBe("queued");
    expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
    const onDisk = JSON.parse(
      await readFile(join(root, m.id, "state.json"), "utf8")
    );
    expect(onDisk).toEqual(m);
  });

  it("save/load roundtrips and leaves no temp files behind", async () => {
    const m = await store.create(baseInit);
    m.status = "running";
    m.startedAt = new Date().toISOString();
    m.sandboxId = "sbx-42";
    await store.save(m);
    expect(await store.load(m.id)).toEqual(m);
    expect(await readdir(join(root, m.id))).toEqual(["state.json"]);
  });

  it("load returns null for a missing mission", async () => {
    expect(await store.load("m-nope")).toBeNull();
  });

  it("lists newest first and tolerates junk folders", async () => {
    const a = await store.create(baseInit);
    const b = await store.create(baseInit);
    const c = await store.create(baseInit);
    a.createdAt = "2026-01-01T00:00:00.000Z";
    b.createdAt = "2026-03-01T00:00:00.000Z";
    c.createdAt = "2026-02-01T00:00:00.000Z";
    await store.save(a);
    await store.save(b);
    await store.save(c);
    // Junk: bad JSON, a non-mission folder, a folder without state.json, a file.
    await mkdir(join(root, "m-junk"));
    await writeFile(join(root, "m-junk", "state.json"), "{not json", "utf8");
    await mkdir(join(root, "Not A Mission"));
    await mkdir(join(root, "m-empty"));
    await writeFile(join(root, "stray.txt"), "hi", "utf8");

    const listed = await store.list();
    expect(listed.map((m) => m.id)).toEqual([b.id, c.id, a.id]);
  });

  it("lists nothing when the root does not exist", async () => {
    const ghost = new MissionStore(join(root, "does-not-exist"));
    expect(await ghost.list()).toEqual([]);
  });

  it("markOrphans fails queued/running missions and persists it", async () => {
    const queued = await store.create(baseInit);
    const running = await store.create(baseInit);
    running.status = "running";
    await store.save(running);
    const done = await store.create(baseInit);
    done.status = "succeeded";
    await store.save(done);

    const marked = await store.markOrphans();
    expect(marked.map((m) => m.id).sort()).toEqual(
      [queued.id, running.id].sort()
    );
    for (const m of marked) {
      expect(m.status).toBe("failed");
      expect(m.error).toBe("orphaned by restart");
      const reloaded = (await store.load(m.id)) as MissionRecord;
      expect(reloaded.status).toBe("failed");
      expect(reloaded.error).toBe("orphaned by restart");
    }
    expect(((await store.load(done.id)) as MissionRecord).status).toBe(
      "succeeded"
    );
    // Second sweep finds nothing left to mark.
    expect(await store.markOrphans()).toEqual([]);
  });

  it("missionDir rejects ids that could escape the root", () => {
    for (const bad of ["../evil", "m-abc/../x", "m-ABC", "m-", "", "m-a b"]) {
      expect(() => store.missionDir(bad)).toThrow(/invalid mission id/);
    }
  });

  it("missionDir returns the folder path for a valid id", () => {
    expect(store.missionDir("m-20260719-4fa1")).toBe(
      join(root, "m-20260719-4fa1")
    );
  });
});

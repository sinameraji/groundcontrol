import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runJanitor } from "../src/janitor.js";
import type { Config } from "../src/types.js";

const NO_DOCKER = "/nonexistent-docker-binary";
const BIG = 2 * 1024 * 1024; // 2 MB against maxArtifactMb: 1

function testConfig(artifactsRoot: string): Config {
  return {
    ownerId: "owner-1",
    agents: [],
    hotcellEndpoint: "http://127.0.0.1:7070",
    artifactsRoot,
    filesPort: 0,
    maxConcurrentMissions: 2,
    defaultModel: "test/model",
    spendCapUsd: 5,
    missionTimeoutMinutes: 45,
    ghPath: "gh",
    janitor: { maxArtifactMb: 1, artifactMaxAgeDays: 30 },
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("runJanitor", () => {
  let root: string;
  let outside: string;
  let missionDir: string;
  const now = new Date();
  const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gc-janitor-"));
    outside = await mkdtemp(join(tmpdir(), "gc-janitor-out-"));
    missionDir = join(root, "m-20260519-aaaa");
    await mkdir(missionDir);

    await writeFile(join(missionDir, "big-old.bin"), Buffer.alloc(BIG));
    await utimes(join(missionDir, "big-old.bin"), oldDate, oldDate);

    await writeFile(join(missionDir, "big-new.bin"), Buffer.alloc(BIG));

    await writeFile(join(missionDir, "small-old.txt"), "tiny\n", "utf8");
    await utimes(join(missionDir, "small-old.txt"), oldDate, oldDate);

    // state.json is immune even when big AND old.
    await writeFile(
      join(missionDir, "state.json"),
      `{"id":"m-20260519-aaaa"}${" ".repeat(BIG)}\n`,
      "utf8"
    );
    await utimes(join(missionDir, "state.json"), oldDate, oldDate);

    // Symlink to a big old file outside the root — must never be followed.
    await writeFile(join(outside, "target.bin"), Buffer.alloc(BIG));
    await utimes(join(outside, "target.bin"), oldDate, oldDate);
    await symlink(join(outside, "target.bin"), join(missionDir, "link.bin"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("prunes only files that are both big and old", async () => {
    const report = await runJanitor(testConfig(root), {
      dockerPath: NO_DOCKER,
      now,
    });
    expect(report.prunedFiles).toEqual([
      join("m-20260519-aaaa", "big-old.bin"),
    ]);
    expect(report.freedBytes).toBe(BIG);

    expect(await exists(join(missionDir, "big-old.bin"))).toBe(false);
    expect(await exists(join(missionDir, "big-new.bin"))).toBe(true);
    expect(await exists(join(missionDir, "small-old.txt"))).toBe(true);
    expect(await exists(join(missionDir, "state.json"))).toBe(true);
    // Symlink itself untouched and its outside target never followed/deleted.
    expect(await exists(join(missionDir, "link.bin"))).toBe(true);
    expect(await exists(join(outside, "target.bin"))).toBe(true);
  });

  it("dryRun reports but deletes nothing", async () => {
    const report = await runJanitor(testConfig(root), {
      dockerPath: NO_DOCKER,
      now,
      dryRun: true,
    });
    expect(report.prunedFiles).toEqual([
      join("m-20260519-aaaa", "big-old.bin"),
    ]);
    expect(report.freedBytes).toBe(BIG);
    expect(await exists(join(missionDir, "big-old.bin"))).toBe(true);
  });

  it("notes a missing docker binary in errors without failing", async () => {
    const report = await runJanitor(testConfig(root), {
      dockerPath: NO_DOCKER,
      now,
    });
    expect(report.errors).toContain("docker not found (skipped)");
  });

  it("returns an empty report when artifactsRoot is missing", async () => {
    const report = await runJanitor(testConfig(join(root, "nope")), {
      dockerPath: NO_DOCKER,
      now,
    });
    expect(report.prunedFiles).toEqual([]);
    expect(report.freedBytes).toBe(0);
  });
});

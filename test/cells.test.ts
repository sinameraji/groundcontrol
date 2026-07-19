import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadCells } from "../src/missions/cells.js";
import type { ThreadCell } from "../src/types.js";

function cell(threadId: string, extra?: Partial<ThreadCell>): ThreadCell {
  return {
    threadId,
    sandboxId: `sbx-${threadId}`,
    agentName: "codey",
    createdAt: "2026-07-01T00:00:00.000Z",
    lastUsedAt: "2026-07-18T00:00:00.000Z",
    missionCount: 1,
    totalCostUsd: 0.5,
    totalTokens: 1000,
    ...extra,
  };
}

describe("ThreadCells", () => {
  let root: string;
  let cells: ThreadCells;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gc-cells-"));
    cells = new ThreadCells(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is empty before any write (no threads.json yet)", async () => {
    expect(await cells.get("t-1")).toBeNull();
    expect(await cells.list()).toEqual([]);
    expect(await cells.findBySandbox("sbx-t-1")).toBeNull();
  });

  it("upsert/get/list roundtrip through disk", async () => {
    const a = cell("t-1", { repo: "https://github.com/you/api" });
    const b = cell("t-2");
    await cells.upsert(a);
    await cells.upsert(b);

    expect(await cells.get("t-1")).toEqual(a);
    expect(await cells.get("t-2")).toEqual(b);
    const listed = await cells.list();
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual(a);
    expect(listed).toContainEqual(b);

    // A fresh instance over the same root sees the same data.
    expect(await new ThreadCells(root).get("t-1")).toEqual(a);
  });

  it("upsert replaces an existing mapping for the same thread", async () => {
    await cells.upsert(cell("t-1"));
    const replaced = cell("t-1", {
      sandboxId: "sbx-new",
      missionCount: 2,
      totalCostUsd: 1.25,
    });
    await cells.upsert(replaced);

    expect(await cells.get("t-1")).toEqual(replaced);
    expect(await cells.list()).toEqual([replaced]);
  });

  it("remove drops the mapping and tolerates unknown ids", async () => {
    await cells.upsert(cell("t-1"));
    await cells.upsert(cell("t-2"));
    await cells.remove("t-1");

    expect(await cells.get("t-1")).toBeNull();
    expect(await cells.get("t-2")).not.toBeNull();
    await expect(cells.remove("t-1")).resolves.toBeUndefined();
    await expect(cells.remove("never-existed")).resolves.toBeUndefined();
  });

  it("findBySandbox reverse-looks-up a thread's cell", async () => {
    const a = cell("t-1");
    await cells.upsert(a);
    await cells.upsert(cell("t-2"));

    expect(await cells.findBySandbox("sbx-t-1")).toEqual(a);
    expect(await cells.findBySandbox("sbx-unknown")).toBeNull();
  });

  it("treats a corrupt threads.json as empty and recovers on write", async () => {
    await writeFile(join(root, "threads.json"), "{definitely not json", "utf8");
    expect(await cells.list()).toEqual([]);
    expect(await cells.get("t-1")).toBeNull();

    const a = cell("t-1");
    await cells.upsert(a);
    expect(await cells.get("t-1")).toEqual(a);
  });

  it("ignores entries that are not cell-shaped", async () => {
    await writeFile(
      join(root, "threads.json"),
      JSON.stringify({
        "t-good": cell("t-good"),
        "t-junk": { threadId: "t-junk" }, // missing sandboxId/lastUsedAt
        "t-worse": 42,
      }),
      "utf8"
    );
    expect(await cells.list()).toEqual([cell("t-good")]);
  });

  it("writes atomically and leaves no *.tmp files behind", async () => {
    await cells.upsert(cell("t-1"));
    await cells.upsert(cell("t-2"));
    await cells.remove("t-1");

    expect(await readdir(root)).toEqual(["threads.json"]);
    const parsed = JSON.parse(
      await readFile(join(root, "threads.json"), "utf8")
    ) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["t-2"]);
  });
});

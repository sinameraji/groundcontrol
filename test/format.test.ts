import { describe, expect, it } from "vitest";
import {
  DISCORD_MAX,
  fmtError,
  fmtQueued,
  fmtResult,
  fmtStarted,
  fmtStatus,
  truncate,
} from "../src/discord/format.js";
import type { MissionRecord } from "../src/types.js";

function record(over: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-20260719-4fa1",
    status: "running",
    agentName: "codey",
    type: "coding",
    prompt: "add rate limiting",
    createdAt: new Date().toISOString(),
    channelId: "123",
    ...over,
  };
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** True when the string has no lone/misordered UTF-16 surrogates. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("truncate", () => {
  it("returns strings at or under max unchanged", () => {
    expect(truncate("", 10)).toBe("");
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("a".repeat(10), 10)).toBe("a".repeat(10));
  });

  it("cuts one-over-max down to max with a … suffix", () => {
    const t = truncate("a".repeat(11), 10);
    expect(t).toBe(`${"a".repeat(8)} …`);
    expect(t.length).toBe(10);
  });

  it("defaults to the 1900-char Discord-safe cap", () => {
    expect(truncate("x".repeat(DISCORD_MAX))).toBe("x".repeat(DISCORD_MAX));
    const t = truncate("x".repeat(DISCORD_MAX + 1));
    expect(t.length).toBeLessThanOrEqual(DISCORD_MAX);
    expect(t.endsWith(" …")).toBe(true);
  });

  it("never leaves a lone surrogate at the cut point", () => {
    const s = "😀".repeat(50); // every code point is a surrogate pair
    for (let max = 3; max <= 21; max++) {
      const t = truncate(s, max);
      expect(t.length).toBeLessThanOrEqual(max);
      expect(t.endsWith(" …")).toBe(true);
      expect(wellFormed(t)).toBe(true);
    }
  });
});

describe("fmtQueued", () => {
  it("includes the mission id and position", () => {
    const s = fmtQueued("m-20260719-4fa1", 3);
    expect(s).toContain("`m-20260719-4fa1`");
    expect(s).toContain("#3 in line");
  });
});

describe("fmtStarted", () => {
  it("includes id, type and model", () => {
    const s = fmtStarted(record(), "moonshotai/kimi-k2.5");
    expect(s).toContain("`m-20260719-4fa1`");
    expect(s).toContain("coding");
    expect(s).toContain("moonshotai/kimi-k2.5");
  });
});

describe("fmtResult", () => {
  it("renders PR link, artifact links, summary and cost", () => {
    const s = fmtResult(
      record({
        status: "succeeded",
        result: {
          prUrl: "https://github.com/o/r/pull/7",
          files: ["report.md", "data.csv"],
          links: ["https://mac.tailnet.ts.net/m-20260719-4fa1/report.md"],
          summary: "shipped the thing",
        },
        costUsd: 0.123,
        tokens: 340_000,
      })
    );
    expect(s).toContain("✅ `m-20260719-4fa1` done");
    expect(s).toContain("PR: https://github.com/o/r/pull/7");
    expect(s).toContain(
      "[report.md](https://mac.tailnet.ts.net/m-20260719-4fa1/report.md)"
    );
    // second file has no link → plain path, no markdown
    expect(s).toContain("📄 data.csv");
    expect(s).not.toContain("[data.csv]");
    expect(s).toContain("shipped the thing");
    expect(s).toContain("≈ $0.12 · 340k tokens");
  });

  it("handles a missing result entirely", () => {
    const s = fmtResult(record({ status: "succeeded" }));
    expect(s).toBe("✅ `m-20260719-4fa1` done");
  });

  it("falls back to plain paths when links are absent", () => {
    const s = fmtResult(
      record({ status: "succeeded", result: { files: ["out/report.md"] } })
    );
    expect(s).toContain("📄 out/report.md");
    expect(s).not.toContain("](");
  });

  it("renders cost-only and tokens-only lines", () => {
    expect(fmtResult(record({ costUsd: 1.5 }))).toContain("≈ $1.50");
    expect(fmtResult(record({ tokens: 999 }))).toContain("≈ 999 tokens");
    expect(fmtResult(record({ tokens: 1000 }))).toContain("≈ 1k tokens");
  });

  it("omits the cost line when neither cost nor tokens are known", () => {
    expect(fmtResult(record())).not.toContain("≈");
  });

  it("stays under the Discord cap for huge summaries", () => {
    const s = fmtResult(
      record({ status: "succeeded", result: { summary: "y".repeat(10_000) } })
    );
    expect(s.length).toBeLessThanOrEqual(DISCORD_MAX);
    expect(s.endsWith(" …")).toBe(true);
  });
});

describe("fmtError", () => {
  it("renders a failure with its error", () => {
    const s = fmtError(record({ status: "failed", error: "sandbox exploded" }));
    expect(s).toContain("💥 `m-20260719-4fa1` failed");
    expect(s).toContain("sandbox exploded");
  });

  it("renders a cancellation", () => {
    const s = fmtError(record({ status: "cancelled" }));
    expect(s).toContain("🛑 `m-20260719-4fa1` cancelled");
  });

  it("stays under the Discord cap for huge errors", () => {
    const s = fmtError(
      record({ status: "failed", error: "e".repeat(10_000) })
    );
    expect(s.length).toBeLessThanOrEqual(DISCORD_MAX);
  });
});

describe("fmtStatus", () => {
  it("says all quiet when nothing is happening", () => {
    expect(fmtStatus([], [])).toContain("all quiet");
  });

  it("lists active and queued missions with human ages", () => {
    const active = [
      record({
        id: "m-20260719-aaaa",
        status: "running",
        startedAt: isoAgo(12 * 60_000),
      }),
      record({
        id: "m-20260719-bbbb",
        agentName: "scout",
        type: "research",
        status: "running",
        startedAt: isoAgo(3 * 3_600_000),
        prompt: "compare vector databases",
      }),
    ];
    const queued = [
      record({
        id: "m-20260719-cccc",
        status: "queued",
        createdAt: isoAgo(42_000),
      }),
    ];
    const s = fmtStatus(active, queued);
    expect(s).toContain("**active (2)**");
    expect(s).toContain("**queued (1)**");
    expect(s).toContain("`m-20260719-aaaa`");
    expect(s).toContain("running 12m");
    expect(s).toContain("running 3h");
    expect(s).toContain("waiting 42s");
    expect(s).toContain("scout · research");
    expect(s).toContain("compare vector databases");
  });

  it("falls back to createdAt age and day units for old active missions", () => {
    const s = fmtStatus(
      [record({ id: "m-20260717-dddd", createdAt: isoAgo(2 * 86_400_000) })],
      []
    );
    expect(s).toContain("running 2d");
  });

  it("snips long prompts to one line", () => {
    const s = fmtStatus(
      [record({ prompt: `do the thing\nwith    ${"z".repeat(200)}` })],
      []
    );
    expect(s).toContain("do the thing with");
    expect(s).not.toContain("\nwith");
    expect(s).toContain("…");
  });

  it("stays under the Discord cap with many missions", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      record({ id: `m-20260719-${i}`, prompt: "p".repeat(120) })
    );
    const s = fmtStatus(many, many);
    expect(s.length).toBeLessThanOrEqual(DISCORD_MAX);
  });
});

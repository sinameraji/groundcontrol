import type { MissionRecord } from "../types.js";

/** Discord hard cap is 2000 chars; leave headroom for safety. */
export const DISCORD_MAX = 1900;

/** Truncate with a trailing " …" when over max. */
export function truncate(s: string, max: number = DISCORD_MAX): string {
  if (s.length <= max) return s;
  const suffix = " …"; // 2 UTF-16 units
  let cut = s.slice(0, Math.max(0, max - suffix.length));
  // Don't leave a lone high surrogate at the cut point (would render as �).
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}${suffix}`;
}

/** "⏳ queued as `m-…` — #N in line" */
export function fmtQueued(missionId: string, position: number): string {
  return `⏳ queued as \`${missionId}\` — #${position} in line`;
}

/** "🚀 `m-…` starting — <type> via <model>" */
export function fmtStarted(m: MissionRecord, model: string): string {
  return truncate(`🚀 \`${m.id}\` starting — ${m.type} via ${model}`);
}

/**
 * Success message: PR link and/or artifact links (files[i] → links[i], fall
 * back to plain path when links are null), summary, cost line
 * ("≈ $0.12 · 340k tokens") when known. 2000-char safe.
 */
export function fmtResult(m: MissionRecord): string {
  const lines: string[] = [`✅ \`${m.id}\` done`];
  const r = m.result ?? {};
  if (r.prUrl) lines.push(`🔀 PR: ${r.prUrl}`);
  (r.files ?? []).forEach((file, i) => {
    const link = r.links?.[i];
    lines.push(link ? `📄 [${file}](${link})` : `📄 ${file}`);
  });
  if (r.summary) lines.push(r.summary);
  const cost = costLine(m.costUsd, m.tokens);
  if (cost) lines.push(cost);
  return truncate(lines.join("\n"));
}

/** Failure/cancel message with the error, 2000-char safe. */
export function fmtError(m: MissionRecord): string {
  const head =
    m.status === "cancelled"
      ? `🛑 \`${m.id}\` cancelled`
      : `💥 \`${m.id}\` failed`;
  const lines = [head];
  if (m.error) lines.push(m.error);
  return truncate(lines.join("\n"));
}

/** /status reply: active + queued missions with ages, or "all quiet". */
export function fmtStatus(
  active: MissionRecord[],
  queued: MissionRecord[]
): string {
  if (active.length === 0 && queued.length === 0) {
    return "✨ all quiet — nothing active, nothing queued";
  }
  const lines: string[] = [];
  if (active.length > 0) {
    lines.push(`**active (${active.length})**`);
    for (const m of active) {
      lines.push(
        `🟢 \`${m.id}\` ${m.agentName} · ${m.type} — running ${age(
          m.startedAt ?? m.createdAt
        )} — ${snippet(m.prompt)}`
      );
    }
  }
  if (queued.length > 0) {
    lines.push(`**queued (${queued.length})**`);
    for (const m of queued) {
      lines.push(
        `⏳ \`${m.id}\` ${m.agentName} · ${m.type} — waiting ${age(
          m.createdAt
        )} — ${snippet(m.prompt)}`
      );
    }
  }
  return truncate(lines.join("\n"));
}

// ── internals ──────────────────────────────────────────────────────────────

/** "≈ $0.12 · 340k tokens" — either part optional, undefined when neither. */
function costLine(costUsd?: number, tokens?: number): string | undefined {
  const parts: string[] = [];
  if (typeof costUsd === "number") parts.push(`$${costUsd.toFixed(2)}`);
  if (typeof tokens === "number") parts.push(`${fmtTokens(tokens)} tokens`);
  return parts.length > 0 ? `≈ ${parts.join(" · ")}` : undefined;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

/** Human age since an ISO timestamp: "42s", "12m", "3h", "2d". */
function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** One-line prompt preview for status listings. */
function snippet(prompt: string, max = 60): string {
  const one = prompt.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

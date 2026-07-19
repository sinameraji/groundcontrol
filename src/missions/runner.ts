import type {
  AgentDef,
  Config,
  DiscordPoster,
  Dispatcher,
  MissionRecord,
  MissionRequest,
  MissionStatus,
  RunnerContext,
  RunnerOutcome,
} from "../types.js";
import { log, logError } from "../log.js";
import type { MissionQueue } from "./queue.js";
import type { MissionStore } from "./store.js";
import type { Hotcell } from "../hotcell.js";
import { runCodingMission } from "../runners/coding.js";
import { runResearchMission } from "../runners/research.js";
import {
  fmtError,
  fmtQueued,
  fmtResult,
  fmtStarted,
} from "../discord/format.js";

interface LiveMission {
  agent: AgentDef;
  /** Set by owner cancel AND by timeout — runners stop at their next check. */
  cancelled: boolean;
  /** Set only by timeout, so the final status reads "failed", not "cancelled". */
  timedOut: boolean;
  sandboxes: Array<{ id: string; destroy(): Promise<void> }>;
}

/**
 * The seam: implements Dispatcher for the Discord side, owns the mission
 * lifecycle (queue → runner → results), enforces the per-mission timeout,
 * and guarantees sandboxes never outlive their mission.
 */
export class MissionEngine implements Dispatcher {
  private poster: DiscordPoster | null = null;
  private readonly live = new Map<string, LiveMission>();

  constructor(
    private readonly cfg: Config,
    private readonly store: MissionStore,
    private readonly queue: MissionQueue,
    private readonly hotcell: Hotcell
  ) {}

  /** Called once the bot fleet is online (poster is the fleet). */
  attachPoster(p: DiscordPoster): void {
    this.poster = p;
  }

  async submit(
    req: MissionRequest
  ): Promise<{ missionId: string; position: number }> {
    const record = await this.store.create({
      agentName: req.agent.name,
      type: req.type,
      prompt: req.prompt,
      repo: req.repo,
      channelId: req.channelId,
    });

    const threadId =
      (await this.poster?.createMissionThread(req, record.id)) ?? null;
    if (threadId) {
      record.threadId = threadId;
      await this.store.save(record);
    }

    this.live.set(record.id, {
      agent: req.agent,
      cancelled: false,
      timedOut: false,
      sandboxes: [],
    });

    const position = this.queue.enqueue(record.id, () =>
      this.execute(record.id)
    );
    log("engine", `mission ${record.id} submitted (position ${position})`);
    if (position > 0) {
      await this.postTo(record, fmtQueued(record.id, position));
    }
    return { missionId: record.id, position };
  }

  async cancel(missionId: string): Promise<boolean> {
    const live = this.live.get(missionId);

    // Still waiting in line → just pull it out and mark it.
    if (this.queue.cancelPending(missionId)) {
      const m = await this.store.load(missionId);
      if (m) {
        m.status = "cancelled";
        m.finishedAt = new Date().toISOString();
        await this.store.save(m);
        await this.postTo(m, "🛑 cancelled before start");
      }
      this.live.delete(missionId);
      return true;
    }

    // Running → flip the flag and yank the sandboxes; the runner's pending
    // exec fails, its finally runs, execute() records "cancelled".
    if (live && this.queue.activeIds().includes(missionId)) {
      live.cancelled = true;
      for (const s of live.sandboxes) void s.destroy().catch(() => {});
      log("engine", `mission ${missionId} cancel requested (running)`);
      return true;
    }
    return false;
  }

  async status(): Promise<{
    active: MissionRecord[];
    queued: MissionRecord[];
  }> {
    const load = async (ids: string[]) => {
      const out: MissionRecord[] = [];
      for (const id of ids) {
        const m = await this.store.load(id);
        if (m) out.push(m);
      }
      return out;
    };
    return {
      active: await load(this.queue.activeIds()),
      queued: await load(this.queue.pendingIds()),
    };
  }

  /**
   * Boot-time follow-up to MissionStore.markOrphans(): destroy any sandbox an
   * orphaned mission left running on the daemon (best-effort — the daemon
   * survives our restarts, so without this, leaked sandboxes accumulate until
   * hotcell's admission control refuses new ones), then tell each thread.
   */
  async handleOrphans(orphans: MissionRecord[]): Promise<void> {
    for (const m of orphans) {
      if (m.sandboxId) await this.hotcell.destroySandbox(m.sandboxId);
      await this.postTo(
        m,
        "⚠️ the orchestrator restarted — this mission was orphaned and marked failed" +
          (m.sandboxId ? "; its sandbox was destroyed" : "") +
          ". Re-run it if still wanted."
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async execute(id: string): Promise<void> {
    const live = this.live.get(id);
    const m = await this.store.load(id);
    if (!m || !live) return;

    if (live.cancelled) {
      await this.close(m, "cancelled");
      this.live.delete(id);
      return;
    }

    m.status = "running";
    m.startedAt = new Date().toISOString();
    await this.store.save(m);
    const model = live.agent.model ?? this.cfg.defaultModel;
    await this.postTo(m, fmtStarted(m, model));

    const ctx: RunnerContext = {
      mission: m,
      agent: live.agent,
      config: this.cfg,
      missionDir: this.store.missionDir(id),
      setStatus: (phase) => this.postTo(m, `· ${phase}`),
      isCancelled: () => live.cancelled,
      registerSandbox: (h) => {
        live.sandboxes.push(h);
        // Late registration into a cancelled/dead mission (e.g. the timeout
        // fired while createSandbox was still in flight): destroy immediately —
        // execute()'s finally sweep may already have run.
        if (live.cancelled || !this.live.has(id)) {
          void h.destroy().catch(() => {});
          return;
        }
        m.sandboxId = h.id;
        void this.store.save(m).catch(() => {});
      },
    };

    const runner = m.type === "coding" ? runCodingMission : runResearchMission;
    const timeoutMs = this.cfg.missionTimeoutMinutes * 60_000;

    try {
      const outcome = await this.withTimeout(
        runner(ctx, this.hotcell),
        timeoutMs,
        id,
        live
      );
      m.result = outcome.result;
      m.costUsd = outcome.costUsd;
      m.tokens = outcome.tokens;
      // A resolved runner means the work completed — a cancel that raced the
      // finish arrived too late to matter, so this is a success either way.
      await this.close(m, "succeeded");
      await this.postTo(m, fmtResult(m));
      log("engine", `mission ${id} ${m.status}`, {
        costUsd: m.costUsd,
        tokens: m.tokens,
      });
    } catch (err) {
      m.error = err instanceof Error ? err.message : String(err);
      // Owner cancels read "cancelled"; timeouts (which also flip the
      // cancelled flag to stop the runner) stay "failed".
      await this.close(
        m,
        live.cancelled && !live.timedOut ? "cancelled" : "failed"
      );
      await this.postTo(m, fmtError(m));
      logError("engine", `mission ${id} ${m.status}`, err);
    } finally {
      // Belt & braces: runners destroy their own sandboxes in their finally;
      // this catches anything left behind on timeout/cancel paths.
      for (const s of live.sandboxes) await s.destroy().catch(() => {});
      this.live.delete(id);
    }
  }

  private async close(m: MissionRecord, status: MissionStatus): Promise<void> {
    m.status = status;
    m.finishedAt = new Date().toISOString();
    await this.store.save(m);
  }

  private async withTimeout(
    p: Promise<RunnerOutcome>,
    ms: number,
    id: string,
    live: LiveMission
  ): Promise<RunnerOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        logError("engine", `mission ${id} timed out — destroying sandboxes`);
        // Flip the flags FIRST: the abandoned runner stops at its next
        // isCancelled() checkpoint instead of ghosting on (e.g. opening a PR
        // after the mission was already reported failed).
        live.timedOut = true;
        live.cancelled = true;
        for (const s of live.sandboxes) void s.destroy().catch(() => {});
        reject(
          new Error(`timed out after ${Math.round(ms / 60_000)} minutes`)
        );
      }, ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // If we lost the race, don't let the abandoned promise crash the process.
      p.catch(() => {});
    }
  }

  private async postTo(m: MissionRecord, content: string): Promise<void> {
    if (!m.threadId || !this.poster) return;
    await this.poster.post(m.agentName, m.threadId, content);
  }
}

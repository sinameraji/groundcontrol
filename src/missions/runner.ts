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
  ThreadCell,
} from "../types.js";
import { log, logError } from "../log.js";
import type { MissionQueue } from "./queue.js";
import type { MissionStore } from "./store.js";
import type { ThreadCells } from "./cells.js";
import type { Hotcell, SandboxHandle } from "../hotcell.js";
import { runCodingMission } from "../runners/coding.js";
import { runResearchMission } from "../runners/research.js";
import { fmtError, fmtQueued, fmtResult } from "../discord/format.js";

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
 * and owns sandbox lifecycle end-to-end — a thread's cell sandbox outlives
 * its missions by design (hotcell's sleepAfter pauses it), everything else
 * is destroyed when its mission ends.
 */
export class MissionEngine implements Dispatcher {
  private poster: DiscordPoster | null = null;
  private readonly live = new Map<string, LiveMission>();
  /** Tail of each thread's mission chain — same-thread missions run strictly
   *  in order (they share ONE cell sandbox; concurrency would corrupt it). */
  private readonly threadChain = new Map<string, Promise<void>>();

  constructor(
    private readonly cfg: Config,
    private readonly store: MissionStore,
    private readonly queue: MissionQueue,
    private readonly hotcell: Hotcell,
    private readonly cells: ThreadCells
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
      requestMessageId: req.requestMessageId,
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
        await this.postTo(m, `🛑 cancelled — it hadn't started yet.\n-# ${m.id}`);
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
   * A sandbox that is some thread's current CELL is spared — the conversation
   * survives the restart.
   */
  async handleOrphans(orphans: MissionRecord[]): Promise<void> {
    for (const m of orphans) {
      let isCell = false;
      if (m.sandboxId) {
        isCell = (await this.cells.findBySandbox(m.sandboxId)) !== null;
        if (!isCell) await this.hotcell.destroySandbox(m.sandboxId);
      }
      await this.postTo(
        m,
        "⚠️ the orchestrator restarted — this mission was orphaned and marked failed" +
          (m.sandboxId
            ? isCell
              ? "; your thread's workspace is safe"
              : "; its sandbox was destroyed"
            : "") +
          ". Re-run it if still wanted."
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Queue entrypoint: same-thread missions are chained so only one runs at a
   * time (a thread has ONE cell — two concurrent runners in it would swap
   * each other's task files, archive each other's outputs, and race the cell
   * mapping). Different threads still run in parallel up to the queue cap.
   */
  private async execute(id: string): Promise<void> {
    const key = (await this.store.load(id))?.threadId;
    if (!key) return this.executeInner(id);

    const prev = this.threadChain.get(key);
    if (prev) {
      const m = await this.store.load(id);
      if (m) {
        await this.setStatusFor(
          m,
          "waiting for the mission ahead in this thread…"
        );
      }
    }
    const run = (prev ?? Promise.resolve()).then(() => this.executeInner(id));
    const tail = run.catch(() => {});
    this.threadChain.set(key, tail);
    try {
      await run;
    } finally {
      if (this.threadChain.get(key) === tail) this.threadChain.delete(key);
    }
  }

  private async executeInner(id: string): Promise<void> {
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
    await this.setStatusFor(m, "getting started…");

    // Resolve the thread's cell BEFORE the runner starts: attach to its
    // sandbox (a paused cell auto-resumes on first use). A mapping whose
    // sandbox the daemon no longer has is stale — drop it and start fresh.
    let cell: ThreadCell | null = null;
    let attached: SandboxHandle | null = null;
    if (m.threadId) {
      cell = await this.cells.get(m.threadId);
      if (cell) {
        attached = await this.hotcell.attachSandbox(cell.sandboxId);
        if (!attached) {
          await this.cells.remove(m.threadId);
          cell = null;
        } else {
          // Track the handle NOW — a cancel/timeout between attach and the
          // runner's registerSandbox must still find (and destroy) it.
          live.sandboxes.push(attached);
          m.sandboxId = attached.id;
          await this.store.save(m);
          // Stamp activity so the janitor never reaps a cell whose thread is
          // mid-mission (lastUsedAt is otherwise only written at settle).
          await this.cells.upsert({
            ...cell,
            lastUsedAt: new Date().toISOString(),
          });
        }
      }
    }
    const threadContext =
      m.threadId && this.poster
        ? await this.poster.fetchContext(
            m.agentName,
            m.threadId,
            m.requestMessageId
          )
        : null;

    const ctx: RunnerContext = {
      mission: m,
      agent: live.agent,
      config: this.cfg,
      missionDir: this.store.missionDir(id),
      cellSandbox: attached ?? null,
      cellReused: attached != null,
      threadContext,
      setStatus: (phase) => this.setStatusFor(m, phase),
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
      await this.settle(m, live, cell, attached != null);
      // A resolved runner means the work completed — a cancel that raced the
      // finish arrived too late to matter, so this is a success either way.
      await this.close(m, "succeeded");
      await this.clearStatusFor(m);
      await this.postTo(m, fmtResult(m));
      log("engine", `mission ${id} ${m.status}`, {
        costUsd: m.costUsd,
        tokens: m.tokens,
      });
    } catch (err) {
      m.error = err instanceof Error ? err.message : String(err);
      const interrupted = live.cancelled || live.timedOut;
      // Ordinary failures still account usage and keep the cell alive —
      // the conversation's workspace survives a bad mission.
      if (!interrupted) await this.settle(m, live, cell, attached != null);
      // Owner cancels read "cancelled"; timeouts (which also flip the
      // cancelled flag to stop the runner) stay "failed".
      await this.close(
        m,
        live.cancelled && !live.timedOut ? "cancelled" : "failed"
      );
      await this.clearStatusFor(m);
      await this.postTo(
        m,
        fmtError(m) +
          (interrupted && m.threadId
            ? "\n-# this thread's workspace was reset — the next mission starts fresh"
            : "")
      );
      logError("engine", `mission ${id} ${m.status}`, err);
    } finally {
      // Destroy ONLY on interrupt (destroy is the interrupt mechanism) — a
      // completed cell mission leaves its sandbox alive by design (sleepAfter
      // pauses it; non-thread missions were destroyed in settle()). The cell
      // mapping goes too: the thread starts a fresh cell next time.
      if (live.cancelled || live.timedOut) {
        for (const s of live.sandboxes) await s.destroy().catch(() => {});
        if (m.threadId) await this.cells.remove(m.threadId).catch(() => {});
      }
      this.live.delete(id);
    }
  }

  /**
   * Post-run accounting, on success and on ordinary failure: snapshot the
   * sandbox's CUMULATIVE usage, record the per-mission delta against the
   * cell's baseline, and upsert the thread's cell — its sandbox stays alive
   * (sleepAfter pauses it). Missions without a thread keep v1 behavior:
   * usage, then destroy.
   */
  private async settle(
    m: MissionRecord,
    live: LiveMission,
    cell: ThreadCell | null,
    reused: boolean
  ): Promise<void> {
    // The runner's working sandbox is the last one registered — undefined
    // when it failed before creating (or attaching) one.
    const sb = live.sandboxes.at(-1);
    if (!sb) return;
    const u = await this.hotcell.usage(sb.id);
    const baseline =
      reused && cell
        ? { costUsd: cell.totalCostUsd, tokens: cell.totalTokens }
        : { costUsd: 0, tokens: 0 };
    m.costUsd = u ? Math.max(0, round2(u.costUsd - baseline.costUsd)) : undefined;
    m.tokens = u ? Math.max(0, u.tokens - baseline.tokens) : undefined;

    if (m.threadId) {
      const now = new Date().toISOString();
      await this.cells.upsert({
        threadId: m.threadId,
        sandboxId: sb.id,
        agentName: cell?.agentName ?? m.agentName,
        repo: m.repo ?? cell?.repo,
        createdAt: cell?.createdAt ?? now,
        lastUsedAt: now,
        missionCount: (cell?.missionCount ?? 0) + 1,
        totalCostUsd: u?.costUsd ?? baseline.costUsd,
        totalTokens: u?.tokens ?? baseline.tokens,
      });
    } else {
      // No thread (creation failed) → no cell to remember it: v1 behavior.
      await sb.destroy().catch(() => {});
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

  private async setStatusFor(m: MissionRecord, content: string): Promise<void> {
    if (!m.threadId || !this.poster) return;
    await this.poster.setStatus(m.agentName, m.threadId, m.id, content);
  }

  private async clearStatusFor(m: MissionRecord): Promise<void> {
    if (!m.threadId || !this.poster) return;
    await this.poster.clearStatus(m.agentName, m.threadId, m.id);
  }
}

/** Round to cents — cost deltas come from subtracting two float totals. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

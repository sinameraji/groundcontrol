/**
 * Concurrency-capped FIFO queue. Not persistent — the MissionStore is the
 * durable record; on restart, unfinished missions are orphaned, not resumed.
 *
 * Runs each job at most once. A job that throws is logged by the caller's
 * wrapper (jobs given to this queue must never reject in practice — the
 * engine wraps everything); the queue itself must survive a rejection and
 * keep draining.
 */
export class MissionQueue {
  private readonly active = new Set<string>();
  private readonly pending: Array<{ id: string; run: () => Promise<void> }> =
    [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  /**
   * Add a job. Returns its 0-based start position: 0 = started immediately,
   * N>0 = N jobs ahead of it.
   */
  enqueue(id: string, run: () => Promise<void>): number {
    if (this.active.size < this.slots()) {
      this.start(id, run);
      return 0;
    }
    this.pending.push({ id, run });
    return this.pending.length;
  }

  /** Remove a still-pending job. False if unknown or already started. */
  cancelPending(id: string): boolean {
    const index = this.pending.findIndex((job) => job.id === id);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    this.notifyIfIdle();
    return true;
  }

  /** Current 0-based queue position of a pending job, or null. */
  position(id: string): number | null {
    const index = this.pending.findIndex((job) => job.id === id);
    return index === -1 ? null : index;
  }

  activeIds(): string[] {
    return [...this.active];
  }

  pendingIds(): string[] {
    return this.pending.map((job) => job.id);
  }

  /** Resolves when nothing is active or pending (for tests). */
  async onIdle(): Promise<void> {
    if (this.active.size === 0 && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Effective slot count — a cap below 1 would stall the queue forever. */
  private slots(): number {
    return Math.max(1, Math.floor(this.maxConcurrent));
  }

  /** Occupy a slot and run the job; the queue survives rejections. */
  private start(id: string, run: () => Promise<void>): void {
    this.active.add(id);
    void Promise.resolve()
      .then(run)
      .catch(() => {
        // Swallowed: the engine's wrapper owns logging; the queue only drains.
      })
      .finally(() => {
        this.active.delete(id);
        this.drain();
      });
  }

  /** Fill free slots from the pending queue, then wake idle waiters if done. */
  private drain(): void {
    while (this.active.size < this.slots()) {
      const next = this.pending.shift();
      if (next === undefined) break;
      this.start(next.id, next.run);
    }
    this.notifyIfIdle();
  }

  private notifyIfIdle(): void {
    if (this.active.size !== 0 || this.pending.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

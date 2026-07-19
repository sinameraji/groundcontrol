import { describe, expect, it } from "vitest";
import { MissionQueue } from "../src/missions/queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("MissionQueue", () => {
  it("runs jobs FIFO and reports start positions", async () => {
    const q = new MissionQueue(1);
    const finished: string[] = [];
    const job = (id: string) => async () => {
      await sleep(5);
      finished.push(id);
    };
    expect(q.enqueue("a", job("a"))).toBe(0);
    expect(q.enqueue("b", job("b"))).toBe(1);
    expect(q.enqueue("c", job("c"))).toBe(2);
    await q.onIdle();
    expect(finished).toEqual(["a", "b", "c"]);
  });

  it("never exceeds maxConcurrent (peak concurrency tracked)", async () => {
    const q = new MissionQueue(2);
    let current = 0;
    let peak = 0;
    let completed = 0;
    for (let i = 0; i < 6; i++) {
      q.enqueue(`job-${i}`, async () => {
        current++;
        peak = Math.max(peak, current);
        await sleep(10);
        current--;
        completed++;
      });
    }
    await q.onIdle();
    expect(peak).toBe(2);
    expect(completed).toBe(6);
  });

  it("fills all free slots before queueing", async () => {
    const q = new MissionQueue(2);
    const gate = deferred();
    const run = () => gate.promise;
    expect(q.enqueue("a", run)).toBe(0);
    expect(q.enqueue("b", run)).toBe(0);
    expect(q.enqueue("c", run)).toBe(1);
    expect(q.enqueue("d", run)).toBe(2);
    expect(q.activeIds().sort()).toEqual(["a", "b"]);
    expect(q.pendingIds()).toEqual(["c", "d"]);
    gate.resolve();
    await q.onIdle();
  });

  it("position reports pending index, null for active/unknown", async () => {
    const q = new MissionQueue(1);
    const gate = deferred();
    q.enqueue("a", () => gate.promise);
    q.enqueue("b", async () => {});
    q.enqueue("c", async () => {});
    expect(q.position("a")).toBeNull();
    expect(q.position("b")).toBe(0);
    expect(q.position("c")).toBe(1);
    expect(q.position("zzz")).toBeNull();
    gate.resolve();
    await q.onIdle();
    expect(q.position("b")).toBeNull();
    expect(q.position("c")).toBeNull();
  });

  it("cancelPending removes only still-pending jobs", async () => {
    const q = new MissionQueue(1);
    const gate = deferred();
    const ran: string[] = [];
    q.enqueue("a", async () => {
      await gate.promise;
      ran.push("a");
    });
    q.enqueue("b", async () => {
      ran.push("b");
    });
    q.enqueue("c", async () => {
      ran.push("c");
    });
    expect(q.cancelPending("b")).toBe(true);
    expect(q.cancelPending("b")).toBe(false);
    expect(q.cancelPending("a")).toBe(false); // already started
    expect(q.cancelPending("nope")).toBe(false);
    expect(q.pendingIds()).toEqual(["c"]);
    gate.resolve();
    await q.onIdle();
    expect(ran).toEqual(["a", "c"]);
  });

  it("keeps draining after a job rejects", async () => {
    const q = new MissionQueue(1);
    const ran: string[] = [];
    q.enqueue("boom", async () => {
      throw new Error("kaput");
    });
    q.enqueue("b", async () => {
      ran.push("b");
    });
    q.enqueue("c", async () => {
      ran.push("c");
    });
    await q.onIdle();
    expect(ran).toEqual(["b", "c"]);
    expect(q.activeIds()).toEqual([]);
    expect(q.pendingIds()).toEqual([]);
  });

  it("survives a synchronously-throwing job", async () => {
    const q = new MissionQueue(1);
    const ran: string[] = [];
    q.enqueue("boom", () => {
      throw new Error("sync kaput");
    });
    q.enqueue("b", async () => {
      ran.push("b");
    });
    await q.onIdle();
    expect(ran).toEqual(["b"]);
  });

  it("onIdle resolves immediately on an empty queue", async () => {
    const q = new MissionQueue(3);
    await q.onIdle();
    await q.onIdle(); // still immediate; waiters don't accumulate
  });

  it("onIdle wakes every concurrent waiter", async () => {
    const q = new MissionQueue(1);
    const gate = deferred();
    q.enqueue("a", () => gate.promise);
    const waiters = Promise.all([q.onIdle(), q.onIdle(), q.onIdle()]);
    gate.resolve();
    await waiters;
    expect(q.activeIds()).toEqual([]);
  });
});

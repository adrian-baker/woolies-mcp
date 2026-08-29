/**
 * Serialises tasks and keeps a minimum gap between their starts.
 *
 * DESIGN.md, "Politeness": this server is one shopper, never a crawler. The gap is enforced
 * here rather than at each call site so no tool can bypass it.
 */
export class Throttle {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  private lastStartedAtMs = Number.NEGATIVE_INFINITY;

  constructor(minIntervalMs: number, now: () => number = Date.now) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(async () => {
      const waitMs = this.lastStartedAtMs + this.minIntervalMs - this.now();
      if (waitMs > 0) await delay(waitMs);
      this.lastStartedAtMs = this.now();
      return task();
    });
    // The chain must not break on a failed task, so the tail swallows the rejection that the
    // caller already receives through `queued`.
    this.tail = queued.catch(() => undefined);
    return queued;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

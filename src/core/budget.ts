/**
 * Sliding-window restart budget (REQ-PR-12).
 *
 * A probe that restart-loops a broken app forever is worse than no probe: it converts a
 * degraded service into a flapping one and buries the real cause.
 */
export class RestartBudget {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] as number) < cutoff) {
      this.stamps.shift();
    }
  }

  remaining(now: number = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.max - this.stamps.length);
  }

  /** Consume one restart if the budget allows. Returns false when exhausted. */
  tryConsume(now: number = Date.now()): boolean {
    this.prune(now);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}

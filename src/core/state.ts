/**
 * Per-INSTANCE health state machine (REQ-PR-07).
 *
 * Transitions happen only on crossing failureThreshold / successThreshold consecutive
 * results, which is what keeps a single blip from causing a restart and what keeps the
 * event stream to transitions rather than ticks.
 */

export type HealthStatus = 'starting' | 'healthy' | 'failing' | 'tripped' | 'giving-up';

export interface Transition {
  from: HealthStatus;
  to: HealthStatus;
  consecutive: number;
}

export class InstanceHealth {
  private status: HealthStatus = 'starting';
  private fails = 0;
  private passes = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly successThreshold: number,
  ) {}

  get current(): HealthStatus {
    return this.status;
  }

  get isHealthy(): boolean {
    return this.status === 'healthy';
  }

  /** Budget exhaustion is decided outside the state machine and pushed in here. */
  markGivingUp(): void {
    this.status = 'giving-up';
  }

  /** Called after a restart is issued, so the next failure can trip again. */
  resetAfterRestart(): void {
    this.status = 'starting';
    this.fails = 0;
    this.passes = 0;
  }

  record(ok: boolean): Transition | null {
    const from = this.status;

    if (ok) {
      this.passes++;
      this.fails = 0;
      const recovering = from === 'tripped' || from === 'failing' || from === 'giving-up';
      if (recovering && this.passes >= this.successThreshold) {
        this.status = 'healthy';
        return { from, to: 'healthy', consecutive: this.passes };
      }
      if (from === 'starting' && this.passes >= this.successThreshold) {
        // First healthy result is not a "recovery" - no event.
        this.status = 'healthy';
      }
      return null;
    }

    this.passes = 0;
    this.fails++;

    if (from === 'tripped' || from === 'giving-up') return null;

    if (this.fails >= this.failureThreshold) {
      this.status = 'tripped';
      return { from, to: 'tripped', consecutive: this.fails };
    }

    // Below threshold: degraded but not yet actionable, and deliberately not an event.
    this.status = 'failing';
    return null;
  }
}

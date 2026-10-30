import { ProbeType } from '../events/contract';

export interface ProbeResult {
  ok: boolean;
  /** Short machine-ish reason, e.g. "status 503", "timeout", "ECONNREFUSED". */
  reason?: string;
  latencyMs: number;
}

export interface ProbeTarget {
  /** Resolved listening port for this instance, when the probe needs one. */
  port: number | null;
  pmId: number;
  /**
   * The instance's `pm2_env.axm_monitor` map, populated only when the app reports
   * metrics via @pm2/io. Empty for an uninstrumented app.
   */
  metrics?: Record<string, unknown>;
}

export interface Probe {
  readonly type: ProbeType;
  run(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult>;
}

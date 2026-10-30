import { LoopLagProbeDef } from '../config/schema';
import { Probe, ProbeResult, ProbeTarget } from './types';

/**
 * Event-loop lag probe.
 *
 * A process cannot measure another process's event loop, so this reads the figure the
 * app reports about itself. PM2 populates `pm2_env.axm_monitor` from `axm:monitor` bus
 * messages, which only apps instrumented with @pm2/io send.
 *
 * The metric NAME is matched by pattern rather than hardcoded: it comes from the
 * instrumentation library, not from PM2, so this module is not in a position to assert
 * what it is called. `metricName` overrides the pattern when needed.
 *
 * An app with no such metric is caught by a guard before any probe runs (see guards.ts).
 * It must never degrade into a probe that silently always passes.
 */

const LAG_PATTERN = /event.?loop.*(latency|lag|delay)/i;

export interface MetricHit {
  name: string;
  valueMs: number;
}

function toMs(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (raw && typeof raw === 'object') {
    const v = (raw as { value?: unknown }).value;
    if (v !== undefined) return toMs(v);
  }
  return null;
}

/** Find the event-loop metric, preferring a mean over a percentile unless named. */
export function findLagMetric(
  metrics: Record<string, unknown> | undefined,
  metricName?: string,
): MetricHit | null {
  if (!metrics) return null;
  const names = Object.keys(metrics);

  if (metricName) {
    const exact = names.find((n) => n.toLowerCase() === metricName.toLowerCase());
    if (!exact) return null;
    const v = toMs(metrics[exact]);
    return v === null ? null : { name: exact, valueMs: v };
  }

  const candidates = names.filter((n) => LAG_PATTERN.test(n)).sort();
  if (candidates.length === 0) return null;
  // A plain mean describes typical health better than a tail percentile; if only a
  // percentile is exported, use it rather than reporting nothing.
  const preferred = candidates.find((n) => !/p\d{2}/i.test(n)) ?? candidates[0]!;
  const v = toMs(metrics[preferred]);
  return v === null ? null : { name: preferred, valueMs: v };
}

export class LoopLagProbe implements Probe {
  readonly type = 'loop-lag' as const;

  constructor(private readonly def: LoopLagProbeDef) {}

  run(target: ProbeTarget): Promise<ProbeResult> {
    const hit = findLagMetric(target.metrics, this.def.metricName);
    if (!hit) {
      // Reported as a failure rather than a pass, but the guard should have prevented
      // this probe from being scheduled at all.
      return Promise.resolve({
        ok: false,
        reason: 'no event-loop metric reported by this instance (is it instrumented?)',
        latencyMs: 0,
      });
    }
    const ok = hit.valueMs <= this.def.maxLagMs;
    return Promise.resolve({
      ok,
      reason: ok ? undefined : `${hit.name} is ${hit.valueMs}ms, over ${this.def.maxLagMs}ms`,
      latencyMs: Math.round(hit.valueMs),
    });
  }
}

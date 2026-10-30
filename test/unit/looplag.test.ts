import { describe, it, expect } from 'vitest';
import { findLagMetric, LoopLagProbe } from '../../src/probes/loopLag';
import { checkLoopLagInstrumentation } from '../../src/core/guards';
import { AppConfig } from '../../src/config/schema';
import { Pm2Process } from '../../src/pm2/types';

describe('findLagMetric', () => {
  it('finds the metric by pattern, since the name comes from the instrumentation', () => {
    expect(findLagMetric({ 'Event Loop Latency': { value: '12.5', unit: 'ms' } }))
      .toEqual({ name: 'Event Loop Latency', valueMs: 12.5 });
  });

  it('accepts plain numbers and bare strings as well as {value} objects', () => {
    expect(findLagMetric({ 'event loop delay': 4 })?.valueMs).toBe(4);
    expect(findLagMetric({ 'Event Loop Lag': '7.25' })?.valueMs).toBe(7.25);
  });

  it('prefers a mean over a percentile when both exist', () => {
    const hit = findLagMetric({
      'Event Loop Latency p95': { value: 90 },
      'Event Loop Latency': { value: 3 },
    });
    expect(hit?.name).toBe('Event Loop Latency');
  });

  it('falls back to a percentile when it is all that is exported', () => {
    expect(findLagMetric({ 'Event Loop Latency p95': { value: 90 } })?.name)
      .toBe('Event Loop Latency p95');
  });

  it('honours an explicit metricName, case-insensitively', () => {
    const m = { 'loopDelayCustom': { value: 11 }, 'Event Loop Latency': { value: 1 } };
    expect(findLagMetric(m, 'loopdelaycustom')?.valueMs).toBe(11);
  });

  it('returns null for an explicit name that is absent', () => {
    expect(findLagMetric({ 'Event Loop Latency': { value: 1 } }, 'nope')).toBeNull();
  });

  it('returns null for an uninstrumented app', () => {
    expect(findLagMetric(undefined)).toBeNull();
    expect(findLagMetric({})).toBeNull();
    expect(findLagMetric({ 'Heap Usage': { value: 10 } })).toBeNull();
  });
});

describe('LoopLagProbe', () => {
  const probe = new LoopLagProbe({ maxLagMs: 50 });

  it('passes under the threshold', async () => {
    const r = await probe.run({ port: null, pmId: 1,
      metrics: { 'Event Loop Latency': { value: 10 } } });
    expect(r.ok).toBe(true);
  });

  it('fails over the threshold and says by how much', async () => {
    const r = await probe.run({ port: null, pmId: 1,
      metrics: { 'Event Loop Latency': { value: 120 } } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/120ms, over 50ms/);
  });

  it('NEVER silently passes an uninstrumented app', async () => {
    // Reporting health it has not measured would be worse than having no probe.
    const r = await probe.run({ port: null, pmId: 1, metrics: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no event-loop metric/);
  });
});

function app(over: Partial<AppConfig> = {}): AppConfig {
  return {
    scope: 'instance', action: 'none', minHealthy: 'auto',
    restartBudget: { max: 3, windowSeconds: 600 },
    liveness: {
      loopLag: { maxLagMs: 100 },
      periodSeconds: 10, timeoutSeconds: 3,
      failureThreshold: 3, successThreshold: 1, initialDelaySeconds: 0,
    },
    ...over,
  } as AppConfig;
}
const proc = (monitor?: Record<string, unknown>): Pm2Process => ({
  name: 'api', pm_id: 0,
  pm2_env: { pm_id: 0, status: 'online', ...(monitor ? { axm_monitor: monitor } : {}) },
});

describe('instrumentation guard', () => {
  it('passes when at least one instance reports the metric', () => {
    expect(checkLoopLagInstrumentation('api', app(),
      [proc({ 'Event Loop Latency': { value: 2 } })])).toBeNull();
  });

  it('refuses an uninstrumented app, with remedies', () => {
    const v = checkLoopLagInstrumentation('api', app(), [proc()]);
    expect(v?.reason).toMatch(/no instance reports an event-loop metric/);
    expect(v?.remedies).toHaveLength(3);
  });

  it('names the configured metric when that is what is missing', () => {
    const cfg = app();
    cfg.liveness!.loopLag!.metricName = 'myMetric';
    const v = checkLoopLagInstrumentation('api', cfg,
      [proc({ 'Event Loop Latency': { value: 2 } })]);
    expect(v?.reason).toMatch(/metricName "myMetric"/);
  });

  it('does not apply when no loopLag probe is configured', () => {
    const cfg = app();
    delete (cfg.liveness as Record<string, unknown>).loopLag;
    (cfg.liveness as Record<string, unknown>).http = { path: '/h', port: 'auto',
      host: '127.0.0.1', scheme: 'http', method: 'GET', expectStatus: [200, 399],
      headers: {}, insecure: false };
    expect(checkLoopLagInstrumentation('api', cfg, [proc()])).toBeNull();
  });
});

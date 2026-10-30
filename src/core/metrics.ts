/**
 * Internal counters, exposed through @pm2/io when it is available so `pm2 monit` shows
 * whether the module is actually working (NFR-6 / REQ-PR-32).
 *
 * @pm2/io is optional: if it is not installed we keep the counters in memory and the
 * module behaves identically. A metrics library must never be load-bearing.
 */

export const counters = {
  probesConfigured: 0,
  probesPassing: 0,
  probesFailing: 0,
  restartsIssued: 0,
  budgetExhaustions: 0,
  quorumBlocks: 0,
  guardBlockedApps: 0,
  lastProbeLatencyMs: 0,
};

export type CounterName = keyof typeof counters;

export function inc(name: CounterName, by = 1): void {
  counters[name] += by;
}

export function set(name: CounterName, value: number): void {
  counters[name] = value;
}

export function registerMetrics(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const io = require('@pm2/io');
    for (const key of Object.keys(counters) as CounterName[]) {
      io.metric({ name: `probe.${key}`, value: () => counters[key] });
    }
  } catch {
    // @pm2/io absent - counters still work, they just aren't published to pm2 monit.
  }
}

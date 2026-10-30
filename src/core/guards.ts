import { AppConfig } from '../config/schema';
import { Pm2Process, resolvePort, isCluster } from '../pm2/types';
import { findLagMetric } from '../probes/loopLag';

/**
 * Cluster addressability guard (REQ-PR-11a).
 *
 * In PM2 cluster mode with a SHARED port, the primary routes each connection to an
 * arbitrary worker. An HTTP probe therefore cannot target a specific instance, and
 * restarting `pm_id` would be restarting an instance the probe never actually tested.
 *
 * Silently probing a shared port and restarting a guessed instance is the worst possible
 * outcome, so we refuse to probe the app and say exactly how to fix it.
 */

export interface GuardViolation {
  app: string;
  reason: string;
  remedies: string[];
}

const REMEDIES = [
  "set `increment_var: 'PORT'` in your ecosystem config so each instance binds its own port",
  'use an exec probe that targets the instance directly via PM2_PROBE_PM_ID',
  "set `scope: 'app'` to accept app-level probing (a trip then restarts the whole app)",
];

export function checkClusterAddressability(
  app: string,
  cfg: AppConfig,
  procs: Pm2Process[],
): GuardViolation | null {
  if (cfg.scope !== 'instance') return null;
  if (procs.length <= 1) return null;

  const net = cfg.liveness?.http ?? cfg.liveness?.tcp ?? cfg.readiness?.http ?? cfg.readiness?.tcp;
  if (!net) return null; // exec probes address the instance directly

  if (!procs.some(isCluster)) return null;

  // An explicitly pinned port means every instance is probed at the same address.
  if (typeof net.port === 'number') {
    return {
      app,
      reason:
        `scope is 'instance' and ${procs.length} cluster instances are running, but the probe ` +
        `targets a fixed port (${net.port}), so it cannot tell them apart`,
      remedies: REMEDIES,
    };
  }

  const ports = procs.map((p) => resolvePort(p));
  if (ports.some((p) => p === null)) {
    return {
      app,
      reason:
        `scope is 'instance' but at least one instance has no resolvable PORT in pm2_env, ` +
        `so the probe has no per-instance address`,
      remedies: REMEDIES,
    };
  }

  const distinct = new Set(ports);
  if (distinct.size < procs.length) {
    return {
      app,
      reason:
        `scope is 'instance' and ${procs.length} cluster instances share ${distinct.size} ` +
        `port(s); PM2 routes a shared port to an arbitrary worker, so per-instance probing ` +
        `is not possible`,
      remedies: REMEDIES,
    };
  }

  return null;
}

/**
 * Event-loop instrumentation guard.
 *
 * A loopLag probe reads a metric the app publishes about itself. If the app is not
 * instrumented the metric is simply absent, and a probe that treats "no data" as "no
 * problem" is worse than no probe at all - it reports health it has never measured.
 * So an uninstrumented app is refused rather than silently passed.
 */
export function checkLoopLagInstrumentation(
  app: string,
  cfg: AppConfig,
  procs: Pm2Process[],
): GuardViolation | null {
  const defs = [cfg.liveness, cfg.readiness].filter((d) => d?.loopLag);
  if (defs.length === 0) return null;

  const metricName = defs[0]?.loopLag?.metricName;
  const instrumented = procs.some((p) => {
    const m = p.pm2_env?.axm_monitor as Record<string, unknown> | undefined;
    return findLagMetric(m, metricName) !== null;
  });
  if (instrumented) return null;

  return {
    app,
    reason: metricName
      ? `a loopLag probe is configured with metricName "${metricName}", but no instance ` +
        `reports a metric by that name`
      : `a loopLag probe is configured, but no instance reports an event-loop metric`,
    remedies: [
      'instrument the app with @pm2/io so it publishes event-loop metrics to PM2',
      'set `metricName` if your instrumentation uses a name this module does not recognise',
      'use an http probe against a route that reports lag itself',
    ],
  };
}

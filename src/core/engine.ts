import { AppConfig, ProbeConfig, ProbeDefinition } from '../config/schema';
import { Pm2Client } from '../pm2/client';
import { Pm2Process, resolvePort, isModule } from '../pm2/types';
import { buildProbe, Probe } from '../probes';
import { ProbeKind, ProbeType } from '../events/contract';
import { emitProbeStatus } from '../events/emit';
import { checkClusterAddressability } from './guards';
import { InstanceHealth } from './state';
import { RestartBudget } from './budget';
import { canRestart } from './quorum';
import { log, logOnce } from '../log';
import * as metrics from './metrics';
import { hostname } from 'node:os';

const HOST = hostname();

interface Watcher {
  key: string;
  app: string;
  pmId: number;
  kind: ProbeKind;
  probe: Probe;
  def: ProbeDefinition;
  health: InstanceHealth;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

/** Jitter the period by +/-10% so instances don't stampede a shared dependency. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

export class Engine {
  private watchers = new Map<string, Watcher>();
  private budgets = new Map<string, RestartBudget>();
  private restarting = new Set<number>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** Cached view for the /livez and /readyz endpoint, which must never probe live. */
  readonly snapshot = new Map<string, { live: boolean; ready: boolean; total: number }>();

  constructor(
    private readonly client: Pm2Client,
    private config: ProbeConfig,
  ) {}

  updateConfig(next: ProbeConfig): void {
    this.config = next;
    for (const w of this.watchers.values()) this.stopWatcher(w);
    this.watchers.clear();
    this.budgets.clear();
    void this.reconcile();
  }

  start(): void {
    void this.reconcile();
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.config.reconcileSeconds * 1000,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const w of this.watchers.values()) this.stopWatcher(w);
    this.watchers.clear();
  }

  /**
   * Pick up apps started, stopped or scaled since the last pass, without needing a
   * module restart (REQ-PR-34).
   */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    let list: Pm2Process[];
    try {
      list = await this.client.list();
    } catch (err) {
      log.warn('pm2 list failed, keeping existing watchers', { error: (err as Error).message });
      return;
    }

    const live = new Set<string>();

    for (const [appName, cfg] of Object.entries(this.config.apps)) {
      // Never probe ourselves or other PM2 modules (REQ-PR-33).
      const procs = list.filter(
        (p) => p.name === appName && !isModule(p) && p.pm2_env?.status === 'online',
      );
      if (procs.length === 0) continue;

      const violation = checkClusterAddressability(appName, cfg, procs);
      if (violation) {
        // Topology problem, not a config-file problem: refuse to probe this app, keep
        // the module up for every other app (NFR-2).
        logOnce(`guard:${appName}:${procs.length}`, 'error', 'refusing to probe app', {
          app: appName,
          reason: violation.reason,
          remedies: violation.remedies,
        });
        metrics.set('guardBlockedApps', 1);
        continue;
      }

      for (const proc of procs) {
        const pmId = proc.pm_id ?? proc.pm2_env?.pm_id;
        if (typeof pmId !== 'number') continue;

        for (const kind of ['liveness', 'readiness'] as ProbeKind[]) {
          const def = cfg[kind];
          if (!def) continue;
          const key = `${appName}:${pmId}:${kind}`;
          live.add(key);
          if (!this.watchers.has(key)) {
            this.spawnWatcher(key, appName, pmId, kind, def, cfg);
          }
        }
      }

      this.updateSnapshot(appName, procs.length);
    }

    // Drop watchers for instances that no longer exist.
    for (const [key, w] of this.watchers) {
      if (!live.has(key)) {
        this.stopWatcher(w);
        this.watchers.delete(key);
      }
    }
    metrics.set('probesConfigured', this.watchers.size);
  }

  private spawnWatcher(
    key: string,
    app: string,
    pmId: number,
    kind: ProbeKind,
    def: ProbeDefinition,
    cfg: AppConfig,
  ): void {
    let probe: Probe;
    try {
      probe = buildProbe(def);
    } catch (err) {
      logOnce(`build:${key}`, 'error', 'cannot build probe', {
        app,
        kind,
        error: (err as Error).message,
      });
      return;
    }

    const w: Watcher = {
      key,
      app,
      pmId,
      kind,
      probe,
      def,
      health: new InstanceHealth(def.failureThreshold, def.successThreshold),
      timer: null,
      stopped: false,
    };
    this.watchers.set(key, w);
    log.debug('watching instance', { app, pm_id: pmId, kind, probe: probe.type });
    this.schedule(w, cfg, jitter(def.periodSeconds * 1000));
  }

  private stopWatcher(w: Watcher): void {
    w.stopped = true;
    if (w.timer) clearTimeout(w.timer);
  }

  private schedule(w: Watcher, cfg: AppConfig, delayMs: number): void {
    if (w.stopped || this.stopped) return;
    w.timer = setTimeout(() => void this.tick(w, cfg), delayMs);
    // Don't hold the event loop open for a probe timer during shutdown.
    w.timer.unref?.();
  }

  private async tick(w: Watcher, cfg: AppConfig): Promise<void> {
    if (w.stopped || this.stopped) return;
    const period = jitter(w.def.periodSeconds * 1000);

    try {
      const proc = await this.findProc(w.app, w.pmId);
      if (!proc) {
        this.schedule(w, cfg, period);
        return;
      }

      // initialDelay is measured from the instance's own uptime, not from module start,
      // so restarting the module does not grant a long-running app a fresh grace period.
      const uptimeMs = Date.now() - (proc.pm2_env?.pm_uptime ?? 0);
      if (uptimeMs < w.def.initialDelaySeconds * 1000) {
        this.schedule(w, cfg, period);
        return;
      }

      const port = resolvePort(proc);
      const result = await w.probe.run(
        { port, pmId: w.pmId },
        Math.round(w.def.timeoutSeconds * 1000),
      );
      metrics.set('lastProbeLatencyMs', result.latencyMs);

      const transition = w.health.record(result.ok);
      if (transition?.to === 'tripped') {
        metrics.inc('probesFailing');
        await this.onTrip(w, cfg, result.reason ?? 'probe failed', transition.consecutive);
      } else if (transition?.to === 'healthy') {
        metrics.inc('probesPassing');
        log.info('instance recovered', { app: w.app, pm_id: w.pmId, kind: w.kind });
        emitProbeStatus({
          state: 'recovered',
          app: w.app,
          pm_id: w.pmId,
          probe: w.probe.type as ProbeType,
          probe_kind: w.kind,
          action: 'none',
          host: HOST,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      // A throwing probe counts as a failure, logged once per transition not per tick.
      logOnce(`tick:${w.key}`, 'warn', 'probe execution error', {
        app: w.app,
        pm_id: w.pmId,
        error: (err as Error).message,
      });
      w.health.record(false);
    }

    this.schedule(w, cfg, period);
  }

  private async onTrip(
    w: Watcher,
    cfg: AppConfig,
    reason: string,
    consecutive: number,
  ): Promise<void> {
    // Readiness failures never restart - they only mark the instance not-ready.
    const restartable = w.kind === 'liveness' && cfg.action === 'restart';
    let action: 'restart' | 'none' = 'none';

    if (restartable) {
      const budget = this.budgetFor(w.app, w.pmId, cfg);
      const peers = [...this.watchers.values()].filter(
        (o) => o.app === w.app && o.kind === 'liveness',
      );
      const healthy = peers.filter((o) => o.health.isHealthy).length;

      if (!canRestart({
        healthy: healthy + 1, // the tripped instance has just left the healthy set
        restarting: this.restarting.size,
        totalInstances: peers.length,
        minHealthy: cfg.minHealthy,
      })) {
        metrics.inc('quorumBlocks');
        log.warn('restart blocked by quorum', {
          app: w.app, pm_id: w.pmId, healthy, minHealthy: cfg.minHealthy,
        });
      } else if (!budget.tryConsume()) {
        metrics.inc('budgetExhaustions');
        w.health.markGivingUp();
        log.error('restart budget exhausted - giving up on this instance', {
          app: w.app, pm_id: w.pmId, budget: cfg.restartBudget,
        });
      } else {
        action = 'restart';
        this.restarting.add(w.pmId);
        log.warn('restarting instance', { app: w.app, pm_id: w.pmId, reason });
        const ok = await this.client.restart(w.pmId);
        this.restarting.delete(w.pmId);
        if (ok) {
          metrics.inc('restartsIssued');
          w.health.resetAfterRestart();
        } else {
          action = 'none';
        }
      }
    } else {
      log.warn('probe tripped', { app: w.app, pm_id: w.pmId, kind: w.kind, reason,
        note: cfg.action === 'none' ? "action is 'none' - not restarting" : undefined });
    }

    emitProbeStatus({
      state: 'fail',
      app: w.app,
      pm_id: w.pmId,
      probe: w.probe.type as ProbeType,
      probe_kind: w.kind,
      reason,
      consecutive,
      threshold: w.def.failureThreshold,
      action,
      host: HOST,
      at: new Date().toISOString(),
    });
  }

  private budgetFor(app: string, pmId: number, cfg: AppConfig): RestartBudget {
    const key = `${app}:${pmId}`;
    let b = this.budgets.get(key);
    if (!b) {
      b = new RestartBudget(cfg.restartBudget.max, cfg.restartBudget.windowSeconds * 1000);
      this.budgets.set(key, b);
    }
    return b;
  }

  private async findProc(app: string, pmId: number): Promise<Pm2Process | null> {
    const list = await this.client.list();
    return (
      list.find(
        (p) => p.name === app && (p.pm_id ?? p.pm2_env?.pm_id) === pmId &&
          p.pm2_env?.status === 'online',
      ) ?? null
    );
  }

  private updateSnapshot(app: string, total: number): void {
    const liveness = [...this.watchers.values()].filter(
      (w) => w.app === app && w.kind === 'liveness',
    );
    const readiness = [...this.watchers.values()].filter(
      (w) => w.app === app && w.kind === 'readiness',
    );
    this.snapshot.set(app, {
      live: liveness.length === 0 || liveness.some((w) => w.health.isHealthy),
      ready: readiness.length === 0 || readiness.some((w) => w.health.isHealthy),
      total,
    });
  }
}

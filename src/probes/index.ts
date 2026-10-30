import { ProbeDefinition } from '../config/schema';
import { Probe } from './types';
import { HttpProbe } from './http';
import { TcpProbe } from './tcp';
import { ExecProbe } from './exec';

export * from './types';

/**
 * loop-lag is deliberately not built yet. It needs the probed app to be instrumented
 * with @pm2/io, and a probe that silently always-passes is worse than one that refuses
 * to start (REQ-PR-04).
 */
export function buildProbe(def: ProbeDefinition): Probe {
  if (def.http) return new HttpProbe(def.http);
  if (def.tcp) return new TcpProbe(def.tcp);
  if (def.exec) return new ExecProbe(def.exec);
  if (def.loopLag) {
    throw new Error(
      'loopLag probes are not implemented in 0.1.0. They require the target app to export ' +
        'event-loop metrics via @pm2/io; use an http probe against a /health route that ' +
        'reports lag instead.',
    );
  }
  throw new Error('no probe type configured');
}

import { ProbeDefinition } from '../config/schema';
import { Probe } from './types';
import { HttpProbe } from './http';
import { TcpProbe } from './tcp';
import { ExecProbe } from './exec';
import { LoopLagProbe } from './loopLag';

export * from './types';
export { findLagMetric } from './loopLag';

export function buildProbe(def: ProbeDefinition): Probe {
  if (def.http) return new HttpProbe(def.http);
  if (def.tcp) return new TcpProbe(def.tcp);
  if (def.exec) return new ExecProbe(def.exec);
  if (def.loopLag) return new LoopLagProbe(def.loopLag);
  throw new Error('no probe type configured');
}

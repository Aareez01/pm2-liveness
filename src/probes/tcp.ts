import * as net from 'node:net';
import { TcpProbeDef } from '../config/schema';
import { Probe, ProbeResult, ProbeTarget } from './types';

export class TcpProbe implements Probe {
  readonly type = 'tcp' as const;

  constructor(private readonly def: TcpProbeDef) {}

  run(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult> {
    const started = Date.now();
    const port = this.def.port === 'auto' ? target.port : this.def.port;

    if (!port) {
      return Promise.resolve({ ok: false, reason: 'port unresolved', latencyMs: 0 });
    }

    return new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const done = (r: Omit<ProbeResult, 'latencyMs'>) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ...r, latencyMs: Date.now() - started });
      };

      const socket = net.connect({ host: this.def.host, port });
      socket.setTimeout(timeoutMs);
      // Connection established is the whole test - we write nothing.
      socket.on('connect', () => done({ ok: true }));
      socket.on('timeout', () => done({ ok: false, reason: 'timeout' }));
      socket.on('error', (err: NodeJS.ErrnoException) =>
        done({ ok: false, reason: err.code ?? err.message }),
      );
    });
  }
}

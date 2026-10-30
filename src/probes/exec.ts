import { spawn } from 'node:child_process';
import { ExecProbeDef } from '../config/schema';
import { Probe, ProbeResult, ProbeTarget } from './types';

export class ExecProbe implements Probe {
  readonly type = 'exec' as const;

  constructor(private readonly def: ExecProbeDef) {}

  run(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult> {
    const started = Date.now();

    return new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const done = (r: Omit<ProbeResult, 'latencyMs'>) => {
        if (settled) return;
        settled = true;
        resolve({ ...r, latencyMs: Date.now() - started });
      };

      // detached so we can kill the whole process group on timeout, and an explicit
      // env so the module's own environment (which holds our config) never leaks in.
      const child = spawn('/bin/sh', ['-c', this.def.command], {
        detached: true,
        stdio: 'ignore',
        env: { ...this.def.env, PM2_PROBE_PM_ID: String(target.pmId),
               ...(target.port ? { PM2_PROBE_PORT: String(target.port) } : {}) },
      });

      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        done({ ok: false, reason: 'timeout' });
      }, timeoutMs);

      child.on('exit', (code) => {
        clearTimeout(timer);
        done(code === 0 ? { ok: true } : { ok: false, reason: `exit code ${code}` });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, reason: err.message });
      });
    });
  }
}

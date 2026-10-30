import * as http from 'node:http';
import * as https from 'node:https';
import { HttpProbeDef } from '../config/schema';
import { Probe, ProbeResult, ProbeTarget } from './types';

export class HttpProbe implements Probe {
  readonly type = 'http' as const;

  constructor(private readonly def: HttpProbeDef) {}

  run(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult> {
    const started = Date.now();
    const port = this.def.port === 'auto' ? target.port : this.def.port;

    if (!port) {
      return Promise.resolve({
        ok: false,
        reason: 'port unresolved (set port explicitly, or ensure PORT is in the app env)',
        latencyMs: 0,
      });
    }

    const lib = this.def.scheme === 'https' ? https : http;
    const wantBody = typeof this.def.bodyMatch === 'string';

    return new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const done = (r: Omit<ProbeResult, 'latencyMs'>) => {
        if (settled) return;
        settled = true;
        resolve({ ...r, latencyMs: Date.now() - started });
      };

      const req = lib.request(
        {
          host: this.def.host,
          port,
          path: this.def.path,
          method: this.def.method,
          headers: this.def.headers,
          timeout: timeoutMs,
          ...(this.def.scheme === 'https' && this.def.insecure ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const code = res.statusCode ?? 0;
          const [lo, hi] = this.def.expectStatus;
          const statusOk = code >= lo && code <= hi;

          if (!statusOk) {
            res.resume();
            return done({ ok: false, reason: `status ${code}` });
          }
          if (!wantBody) {
            res.resume();
            return done({ ok: true });
          }

          // Only buffer a body when we actually need to match against it, and cap it.
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (body.length < 64 * 1024) body += chunk;
          });
          res.on('end', () => {
            const re = new RegExp(this.def.bodyMatch as string);
            done(
              re.test(body)
                ? { ok: true }
                : { ok: false, reason: `body did not match /${this.def.bodyMatch}/` },
            );
          });
        },
      );

      // A timeout is a failure, not an error to retry (REQ-PR-08).
      req.on('timeout', () => {
        req.destroy();
        done({ ok: false, reason: 'timeout' });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        done({ ok: false, reason: err.code ?? err.message });
      });
      req.end();
    });
  }
}

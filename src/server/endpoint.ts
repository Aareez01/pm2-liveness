import * as http from 'node:http';
/** Just enough of the Engine to serve cached state - keeps this unit-testable. */
export interface SnapshotSource {
  readonly snapshot: Map<string, { live: boolean; ready: boolean; total: number }>;
}
import { log } from '../log';

/**
 * Optional /livez and /readyz for an external load balancer (REQ-PR-18..21).
 *
 * Disabled by default and bound to loopback unless explicitly configured otherwise:
 * a health endpoint that reports on every app on the host is an information disclosure
 * if exposed carelessly.
 *
 * It serves CACHED state only and never triggers a live probe - otherwise an LB health
 * check becomes an amplification vector against the app it is supposed to protect.
 */
export function startEndpoint(
  engine: SnapshotSource,
  opts: { host: string; port: number },
): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/livez' && path !== '/readyz') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', endpoints: ['/livez', '/readyz'] }));
      return;
    }

    const want: 'live' | 'ready' = path === '/livez' ? 'live' : 'ready';
    const apps: Record<string, boolean> = {};
    let allOk = true;
    for (const [app, s] of engine.snapshot) {
      const ok = want === 'live' ? s.live : s.ready;
      apps[app] = ok;
      if (!ok) allOk = false;
    }

    res.writeHead(allOk ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: allOk ? 'ok' : 'degraded', apps }));
  });

  server.on('error', (err) => {
    log.error('health endpoint error', { error: (err as Error).message });
  });

  server.listen(opts.port, opts.host, () => {
    // Report the port actually bound - opts.port may be 0 (ephemeral).
    const addr = server.address();
    const bound = addr && typeof addr === 'object' ? addr.port : opts.port;
    log.info('health endpoint listening', { host: opts.host, port: bound });
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      log.warn('health endpoint is NOT bound to loopback - it is reachable from the network', {
        host: opts.host,
      });
    }
  });

  return server;
}

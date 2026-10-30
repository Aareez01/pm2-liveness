import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { startEndpoint, SnapshotSource } from '../../src/server/endpoint';

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

function serve(entries: [string, { live: boolean; ready: boolean; total: number }][]) {
  const source: SnapshotSource = { snapshot: new Map(entries) };
  server = startEndpoint(source, { host: '127.0.0.1', port: 0 });
  return new Promise<number>((resolve) => {
    server!.on('listening', () => resolve((server!.address() as AddressInfo).port));
  });
}

function get(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    }).on('error', reject);
  });
}

describe('/livez and /readyz', () => {
  it('returns 200 when everything is healthy', async () => {
    const port = await serve([['api', { live: true, ready: true, total: 2 }]]);
    expect((await get(port, '/livez')).status).toBe(200);
    const r = await get(port, '/readyz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: 'ok', apps: { api: true } });
  });

  it('returns 503 when an app is not ready, naming it', async () => {
    const port = await serve([
      ['api', { live: true, ready: false, total: 2 }],
      ['web', { live: true, ready: true, total: 1 }],
    ]);
    const r = await get(port, '/readyz');
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({
      status: 'degraded', apps: { api: false, web: true },
    });
  });

  it('separates liveness from readiness', async () => {
    const port = await serve([['api', { live: false, ready: true, total: 1 }]]);
    expect((await get(port, '/livez')).status).toBe(503);
    expect((await get(port, '/readyz')).status).toBe(200);
  });

  it('is 200 with no apps configured rather than failing closed', async () => {
    const port = await serve([]);
    expect((await get(port, '/readyz')).status).toBe(200);
  });

  it('404s anything else and advertises the real endpoints', async () => {
    const port = await serve([['api', { live: true, ready: true, total: 1 }]]);
    const r = await get(port, '/metrics');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).endpoints).toEqual(['/livez', '/readyz']);
  });

  it('ignores a query string', async () => {
    const port = await serve([['api', { live: true, ready: true, total: 1 }]]);
    expect((await get(port, '/readyz?from=alb')).status).toBe(200);
  });
});

import { describe, it, expect } from 'vitest';
import { checkClusterAddressability } from '../../src/core/guards';
import { AppConfig } from '../../src/config/schema';
import { Pm2Process } from '../../src/pm2/types';

function app(over: Partial<AppConfig> = {}): AppConfig {
  return {
    scope: 'instance',
    action: 'restart',
    minHealthy: 'auto',
    restartBudget: { max: 3, windowSeconds: 600 },
    liveness: {
      http: {
        path: '/health', port: 'auto', host: '127.0.0.1', scheme: 'http',
        method: 'GET', expectStatus: [200, 399], headers: {}, insecure: false,
      },
      periodSeconds: 10, timeoutSeconds: 3,
      failureThreshold: 3, successThreshold: 1, initialDelaySeconds: 0,
    },
    ...over,
  } as AppConfig;
}

function proc(pmId: number, port?: number | null, mode = 'cluster_mode'): Pm2Process {
  return {
    name: 'api',
    pm_id: pmId,
    pm2_env: { pm_id: pmId, status: 'online', exec_mode: mode,
      ...(port == null ? {} : { PORT: port }) },
  };
}

describe('cluster addressability guard (REQ-PR-11a)', () => {
  it('passes when each cluster instance has its own port', () => {
    expect(checkClusterAddressability('api', app(), [proc(0, 3100), proc(1, 3101)]))
      .toBeNull();
  });

  it('blocks when cluster instances share one port', () => {
    const v = checkClusterAddressability('api', app(), [proc(0, 3000), proc(1, 3000)]);
    expect(v).not.toBeNull();
    expect(v?.reason).toMatch(/share/);
    expect(v?.remedies.length).toBe(3);
  });

  it('blocks when a port cannot be resolved at all', () => {
    const v = checkClusterAddressability('api', app(), [proc(0, 3100), proc(1, null)]);
    expect(v?.reason).toMatch(/no resolvable PORT/);
  });

  it('blocks when the probe pins a fixed port across instances', () => {
    const cfg = app();
    cfg.liveness!.http!.port = 3000;
    const v = checkClusterAddressability('api', cfg, [proc(0, 3100), proc(1, 3101)]);
    expect(v?.reason).toMatch(/fixed port/);
  });

  it("allows a shared port when scope is 'app'", () => {
    expect(checkClusterAddressability('api', app({ scope: 'app' }),
      [proc(0, 3000), proc(1, 3000)])).toBeNull();
  });

  it('does not apply to a single instance', () => {
    expect(checkClusterAddressability('api', app(), [proc(0, 3000)])).toBeNull();
  });

  it('does not apply to fork mode', () => {
    expect(checkClusterAddressability('api', app(),
      [proc(0, 3000, 'fork_mode'), proc(1, 3000, 'fork_mode')])).toBeNull();
  });
});

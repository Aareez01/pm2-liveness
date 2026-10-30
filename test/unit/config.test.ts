import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError } from '../../src/config/schema';

describe('config validation', () => {
  it('applies defaults, including the safe action: none', () => {
    const c = parseConfig({ apps: { api: { liveness: { http: { path: '/health' } } } } });
    expect(c.apps.api!.action).toBe('none');
    expect(c.apps.api!.scope).toBe('instance');
    expect(c.apps.api!.liveness!.periodSeconds).toBe(10);
    expect(c.apps.api!.liveness!.http!.port).toBe('auto');
    expect(c.endpoint.enabled).toBe(false);
    expect(c.endpoint.host).toBe('127.0.0.1');
  });

  it('names the offending path on error (NFR-8)', () => {
    try {
      parseConfig({ apps: { api: { liveness: { http: { path: '/h' }, periodSeconds: '10s' } } } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join()).toMatch(/apps\.api\.liveness\.periodSeconds/);
    }
  });

  it('rejects a probe with no type', () => {
    expect(() => parseConfig({ apps: { api: { liveness: {} } } })).toThrow(ConfigError);
  });

  it('rejects a probe with two types', () => {
    expect(() =>
      parseConfig({ apps: { api: { liveness: { http: { path: '/h' }, tcp: {} } } } }),
    ).toThrow(ConfigError);
  });

  it('rejects an app with neither liveness nor readiness', () => {
    expect(() => parseConfig({ apps: { api: {} } })).toThrow(ConfigError);
  });

  it('rejects a path that is not a path', () => {
    expect(() => parseConfig({ apps: { api: { liveness: { http: { path: 'health' } } } } }))
      .toThrow(ConfigError);
  });
});

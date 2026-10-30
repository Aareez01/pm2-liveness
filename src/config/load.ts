import { readFileSync, watch, FSWatcher, existsSync } from 'node:fs';
import { extname } from 'node:path';
import * as yaml from 'js-yaml';
import { parseConfig, ProbeConfig, ConfigError } from './schema';
import { log } from '../log';

/**
 * Two supported config channels (a `probe` block in ecosystem.config.js is NOT one of
 * them - PM2 strips unknown keys silently; see the README troubleshooting section):
 *
 *   1. Module config:  pm2 set pm2-probe:apps '<json>'
 *   2. Sidecar file:   pm2 set pm2-probe:configFile /etc/pm2-probe/config.yaml
 *
 * The sidecar file wins when both are present, and we log which one was used at boot.
 */

export interface LoadedConfig {
  config: ProbeConfig;
  source: 'file' | 'module-config' | 'empty';
  path?: string;
}

/** PM2 injects module config as env vars on the module process. */
function fromModuleConfig(env: NodeJS.ProcessEnv): LoadedConfig {
  const rawApps = env.apps ?? env.pm2_probe_apps ?? '{}';
  let apps: unknown = {};
  try {
    apps = JSON.parse(rawApps);
  } catch (err) {
    throw new ConfigError([
      `apps: not valid JSON (${(err as Error).message}). ` +
        `Set it with: pm2 set pm2-probe:apps '{"myapp":{...}}'`,
    ]);
  }

  const raw: Record<string, unknown> = { apps };
  if (env.logLevel) raw.logLevel = env.logLevel;
  if (env.reconcileSeconds) raw.reconcileSeconds = Number(env.reconcileSeconds);
  raw.endpoint = {
    enabled: env.endpointEnabled === 'true',
    host: env.endpointHost ?? '127.0.0.1',
    port: env.endpointPort ? Number(env.endpointPort) : 9615,
  };

  const config = parseConfig(raw);
  const empty = Object.keys(config.apps).length === 0;
  return { config, source: empty ? 'empty' : 'module-config' };
}

function fromFile(path: string): LoadedConfig {
  if (!existsSync(path)) {
    throw new ConfigError([`configFile: no such file: ${path}`]);
  }
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  let raw: unknown;
  try {
    raw = ext === '.json' ? JSON.parse(text) : yaml.load(text);
  } catch (err) {
    throw new ConfigError([`configFile: could not parse ${path}: ${(err as Error).message}`]);
  }
  return { config: parseConfig(raw), source: 'file', path };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const file = (env.configFile ?? '').trim();
  const loaded = file ? fromFile(file) : fromModuleConfig(env);
  log.info('configuration loaded', {
    source: loaded.source,
    path: loaded.path,
    apps: Object.keys(loaded.config.apps),
  });
  if (loaded.source === 'empty') {
    log.warn(
      'no apps configured - pm2-probe is idle. ' +
        "Configure with: pm2 set pm2-probe:apps '{\"myapp\":{\"liveness\":{\"http\":{\"path\":\"/health\"}}}}'",
    );
  }
  return loaded;
}

/** Watch the sidecar file and reload without restarting the module (debounced). */
export function watchConfigFile(path: string, onChange: (c: LoadedConfig) => void): FSWatcher | null {
  try {
    let timer: NodeJS.Timeout | null = null;
    const w = watch(path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const next = fromFile(path);
          log.info('configuration reloaded', { path });
          onChange(next);
        } catch (err) {
          // A bad edit must not take the module down - keep running the old config.
          log.error('config reload failed, keeping previous configuration', {
            path,
            error: (err as Error).message,
          });
        }
      }, 1000);
    });
    return w;
  } catch (err) {
    log.warn('could not watch config file', { path, error: (err as Error).message });
    return null;
  }
}

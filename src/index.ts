/**
 * pm2-liveness entry point.
 *
 * Runs as an ordinary PM2-managed process (`pm2 install pm2-liveness`). PM2 injects the
 * module configuration as environment variables and restarts us automatically when
 * `pm2 set pm2-liveness:<key>` changes one, so a restart is the normal config-reload path.
 */
import { FSWatcher } from 'node:fs';
import * as http from 'node:http';
import { loadConfig, watchConfigFile } from './config/load';
import { ConfigError } from './config/schema';
import { Pm2Client } from './pm2/client';
import { Engine } from './core/engine';
import { startEndpoint } from './server/endpoint';
import { registerMetrics } from './core/metrics';
import { log, setLogLevel } from './log';

async function main(): Promise<void> {
  const loaded = loadConfig();
  setLogLevel(loaded.config.logLevel);
  registerMetrics();

  const client = new Pm2Client();
  await client.connect();

  const engine = new Engine(client, loaded.config);
  engine.start();

  let server: http.Server | null = null;
  if (loaded.config.endpoint.enabled) {
    server = startEndpoint(engine, {
      host: loaded.config.endpoint.host,
      port: loaded.config.endpoint.port,
    });
  }

  let watcher: FSWatcher | null = null;
  if (loaded.source === 'file' && loaded.path) {
    watcher = watchConfigFile(loaded.path, (next) => {
      setLogLevel(next.config.logLevel);
      engine.updateConfig(next.config);
    });
  }

  log.info('pm2-liveness started', {
    apps: Object.keys(loaded.config.apps).length,
    source: loaded.source,
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    engine.stop();
    watcher?.close();
    server?.close();
    client.disconnect();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Nothing may escape and take the module down next to healthy apps (NFR-2). A module
 * that crash-loops beside a working service is worse than the gap it fills.
 */
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err.message, stack: err.stack });
});

main().catch((err) => {
  if (err instanceof ConfigError) {
    // Configuration errors are fatal and loud, naming the offending key (NFR-8).
    log.error('startup aborted: invalid configuration', { issues: err.issues });
  } else {
    log.error('startup failed', { error: (err as Error).message });
  }
  process.exit(1);
});

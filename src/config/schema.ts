import { z } from 'zod';

/**
 * Config is validated at boot and the module refuses to start on error, naming the
 * offending path (REQ-PR-28 / NFR-8).
 *
 * Loud validation is deliberately a feature here. PM2 itself silently DISCARDS unknown
 * keys from ecosystem.config.js (verified: Config.validateJSON builds a whitelist), so
 * users are used to config vanishing with no explanation. We do the opposite.
 */

const httpProbe = z.object({
  path: z.string().startsWith('/'),
  /** 'auto' resolves the port per instance from pm2_env (PORT or env.PORT). */
  port: z.union([z.number().int().positive(), z.literal('auto')]).default('auto'),
  host: z.string().default('127.0.0.1'),
  scheme: z.enum(['http', 'https']).default('http'),
  method: z.string().default('GET'),
  expectStatus: z.tuple([z.number().int(), z.number().int()]).default([200, 399]),
  bodyMatch: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  insecure: z.boolean().default(false),
});

const tcpProbe = z.object({
  port: z.union([z.number().int().positive(), z.literal('auto')]).default('auto'),
  host: z.string().default('127.0.0.1'),
});

const execProbe = z.object({
  command: z.string().min(1),
  /** Explicit env only - we never leak the module's own environment into a probed command. */
  env: z.record(z.string(), z.string()).default({}),
});

const loopLagProbe = z.object({
  maxLagMs: z.number().int().positive().default(1000),
  /**
   * Exact axm_monitor metric name to read. When omitted, the first metric whose name
   * looks like an event-loop latency/lag/delay figure is used. Set this explicitly if
   * your instrumentation names it something unusual.
   */
  metricName: z.string().optional(),
});

const probeDef = z
  .object({
    http: httpProbe.optional(),
    tcp: tcpProbe.optional(),
    exec: execProbe.optional(),
    loopLag: loopLagProbe.optional(),

    periodSeconds: z.number().positive().default(10),
    timeoutSeconds: z.number().positive().default(3),
    failureThreshold: z.number().int().positive().default(3),
    successThreshold: z.number().int().positive().default(1),
    initialDelaySeconds: z.number().nonnegative().default(0),
  })
  .refine(
    (p) => [p.http, p.tcp, p.exec, p.loopLag].filter(Boolean).length === 1,
    { message: 'exactly one of http, tcp, exec or loopLag must be set' },
  );

const restartBudget = z.object({
  max: z.number().int().nonnegative().default(3),
  windowSeconds: z.number().int().positive().default(600),
});

const appConfig = z
  .object({
    /**
     * 'instance' probes each cluster instance separately and restarts only the failing
     * one. It requires per-instance addressability - see the cluster guard (REQ-PR-11a).
     * 'app' probes the app as a whole; a trip restarts the whole app.
     */
    scope: z.enum(['instance', 'app']).default('instance'),

    /**
     * Default is 'none': probe and emit events, never restart. A probe that restarts a
     * healthy app because a shared dependency blipped is worse than no probe, so the
     * destructive mode is opt-in (REQ-PR-15).
     */
    action: z.enum(['none', 'restart']).default('none'),

    /**
     * Never restart if it would leave fewer than this many instances up (REQ-PR-13).
     * 'auto' means max(1, floor(instances / 2)).
     */
    minHealthy: z.union([z.number().int().nonnegative(), z.literal('auto')]).default('auto'),

    restartBudget: restartBudget.default({ max: 3, windowSeconds: 600 }),

    liveness: probeDef.optional(),
    readiness: probeDef.optional(),
  })
  .refine((a) => a.liveness || a.readiness, {
    message: 'at least one of liveness or readiness must be defined',
  });

export const configSchema = z.object({
  apps: z.record(z.string(), appConfig).default({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  reconcileSeconds: z.number().int().positive().default(30),
  endpoint: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(9615),
    })
    .default({ enabled: false, host: '127.0.0.1', port: 9615 }),
});

export type ProbeDefinition = z.infer<typeof probeDef>;
export type AppConfig = z.infer<typeof appConfig>;
export type ProbeConfig = z.infer<typeof configSchema>;
export type HttpProbeDef = z.infer<typeof httpProbe>;
export type TcpProbeDef = z.infer<typeof tcpProbe>;
export type ExecProbeDef = z.infer<typeof execProbe>;
export type LoopLagProbeDef = z.infer<typeof loopLagProbe>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid pm2-liveness configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse and validate, reporting the exact path of each offending key. */
export function parseConfig(raw: unknown): ProbeConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
  throw new ConfigError(issues);
}

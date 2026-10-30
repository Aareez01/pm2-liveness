# pm2-probe

Active liveness and readiness probes for PM2. Detects hung-but-alive processes and
restarts **only the failing instance**.

PM2 reports a process as `online` whenever its OS process is alive. A Node app with a
blocked event loop, an exhausted connection pool, or one returning 503 to every request
is `online` by that definition and will never be restarted. PM2's only health signals are
*crash* and *memory ceiling*. `pm2-probe` adds the missing one.

```
pm2 install pm2-probe
pm2 set pm2-probe:apps '{"api":{"liveness":{"http":{"path":"/health"}}}}'
```

By default it **observes and reports but never restarts**. See [Actions](#actions).

---

## Why can't I configure this in `ecosystem.config.js`?

**Because PM2 would silently throw your configuration away.**

This is the single most common surprise, so it is worth being precise. PM2 validates every
app definition through `Config.validateJSON`, which builds its result as a *whitelist*: it
iterates the ~65 keys in its own schema, copies matching keys into a fresh object, and
discards everything else. Verified against PM2 7.1.1:

| Key in `ecosystem.config.js` | Survives into `pm2_env`? |
| --- | --- |
| `probe: { ... }` | **No** |
| `pm2_ops: { ... }` | **No** |
| `name`, `script`, `env`, `increment_var` | Yes |

No warning is printed. The key simply vanishes. So `pm2-probe` is configured through one
of the two channels below instead.

### Channel 1 — module config (simple setups)

```bash
pm2 set pm2-probe:apps '{"api":{"liveness":{"http":{"path":"/health"},"periodSeconds":10}}}'
```

`pm2 set` restarts the module automatically, so the change takes effect immediately.

### Channel 2 — a sidecar file (recommended beyond a couple of apps)

```bash
pm2 set pm2-probe:configFile /etc/pm2-probe/config.yaml
```

```yaml
logLevel: info
reconcileSeconds: 30

endpoint:
  enabled: false          # off by default; see Health endpoint
  host: 127.0.0.1
  port: 9615

apps:
  api:
    action: restart       # 'none' (default) observes only
    scope: instance       # or 'app'
    minHealthy: auto      # max(1, half) for clusters; 0 for single-instance apps
    restartBudget:
      max: 3
      windowSeconds: 600
    liveness:
      http:
        path: /health
        port: auto        # resolved per instance from pm2_env
        expectStatus: [200, 299]
      periodSeconds: 10
      timeoutSeconds: 3
      failureThreshold: 3
      initialDelaySeconds: 15
    readiness:
      http: { path: /readyz }
      periodSeconds: 5
```

The file is watched and reloaded without a module restart. A bad edit is rejected and the
previous configuration keeps running. The sidecar file wins if both channels are set, and
the module logs which one it used at boot.

---

## Probe types

| Type | Config | Notes |
| --- | --- | --- |
| `http` | `{ path, port, host, scheme, method, expectStatus, bodyMatch, headers, insecure }` | `port: auto` resolves per instance |
| `tcp` | `{ port, host }` | succeeds on connect; writes nothing |
| `exec` | `{ command, env }` | exit `0` passes; killed by process group on timeout |
| `loopLag` | — | **not implemented in 0.1.0**, see below |

A timeout counts as a failure, not an error to retry.

`loopLag` requires the probed app to export event-loop metrics via `@pm2/io`. Rather than
silently always-passing when the app isn't instrumented, it refuses to start. Use an HTTP
probe against a route that reports its own lag instead.

---

## Actions

`action` defaults to **`none`**: probe, track state, emit events, never restart.

This is deliberate. A probe that restarts a healthy app because a shared database blipped
converts a degraded service into a flapping one. Run in `none` for a few days, read the
events, then switch to `restart` once the thresholds are right.

Three safety rails apply when `action: restart`:

- **Per-instance only.** A trip restarts the one failing instance via `pm2.restart(pm_id)`,
  never the whole app.
- **Restart budget.** At most `max` restarts per instance per `windowSeconds` (default 3 per
  10 min). On exhaustion the module gives up on that instance and keeps emitting events —
  restart-looping a broken app forever is worse than not restarting it.
- **Quorum.** A restart is blocked if it would leave fewer than `minHealthy` instances
  serving. `auto` means `max(1, floor(instances / 2))` for clusters and `0` for a
  single-instance app, which has no quorum to protect.

---

## Cluster mode needs per-instance ports

In PM2 cluster mode with a **shared** port, the primary routes each connection to an
arbitrary worker. An HTTP probe therefore cannot tell instances apart, and restarting a
`pm_id` would be restarting an instance the probe never actually tested.

`pm2-probe` detects this and **refuses to probe the app** rather than guessing:

```
refusing to probe app  app=api
  reason: scope is 'instance' and 4 cluster instances share 1 port(s); PM2 routes a
          shared port to an arbitrary worker, so per-instance probing is not possible
```

Three ways to resolve it:

1. `increment_var: 'PORT'` in your ecosystem config, so each instance binds its own port;
2. an `exec` probe, which receives `PM2_PROBE_PM_ID` and targets the instance directly;
3. `scope: 'app'`, accepting app-level probing (a trip then restarts the whole app).

Other apps keep being probed normally — one misconfigured app never takes the module down.

---

## Events

On every **transition** (never per tick) the module emits `pm2-probe:status` on the PM2 bus.
Any process can consume it:

```js
pm2.launchBus((err, bus) => {
  bus.on('pm2-probe:status', (m) => console.log(m.data));
});
```

```jsonc
{
  "v": 1,                      // contract version; ignore payloads you don't understand
  "state": "fail",             // "pass" | "fail" | "recovered"
  "app": "api",
  "pm_id": 1,
  "probe": "http",
  "probe_kind": "liveness",
  "reason": "status 503",
  "consecutive": 3,
  "threshold": 3,
  "action": "restart",         // what the probe DID
  "host": "web-01",
  "at": "2026-10-30T20:51:00.000Z"
}
```

This is a **wire contract**, versioned like any webhook payload. Required fields are `v`,
`state`, `app`, `pm_id`, `probe`, `probe_kind` and `at`; everything else is optional, and
consumers must tolerate unknown extra fields. New optional fields do not bump `v`; removing
or retyping one does.

> PM2 attaches its own `process` envelope to bus messages, and it identifies the **emitter**
> (`pm2-probe`), not the subject. Read the app and instance from `data.app` / `data.pm_id`.

---

## Health endpoint

Optional, **disabled by default**, and bound to `127.0.0.1` unless you say otherwise:

```yaml
endpoint: { enabled: true, host: 127.0.0.1, port: 9615 }
```

`GET /livez` and `GET /readyz` return `200` or `503` with a per-app JSON summary. Both serve
cached state and never trigger a live probe, so a load balancer health check cannot become
an amplification vector against your app.

---

## Troubleshooting

### Every `pm2` command hangs and never returns

Your `PM2_HOME` path is too long. PM2 binds `$PM2_HOME/rpc.sock`, and Linux caps unix socket
paths (`sun_path`) at **107 characters**. Over that limit the bind fails *silently*: the
daemon starts and writes `pm2.pid` and `logs/`, but no `.sock` file is ever created and every
client — including `pm2 kill` — blocks forever. The orphaned daemon spins at 100% CPU.

```bash
echo -n "$PM2_HOME/rpc.sock" | wc -c     # must be < 107
ls "$PM2_HOME"/*.sock                    # should exist
```

Recover by killing the daemon by PID (`pkill -f "God Daemon"`) and using a shorter
`PM2_HOME`. This bites CI fixtures and containers most often.

### The module starts but probes nothing

Check `pm2 logs pm2-probe`. Apps with no probe configured are ignored entirely, and the
module logs the app names it loaded at boot.

### Config changes aren't taking effect

`pm2 set` restarts the module for you. Hand-editing `~/.pm2/module_conf.json` does **not** —
run `pm2 restart pm2-probe` after.

---

## Design documentation

- [`docs/requirements.md`](./docs/requirements.md) — the requirements this module was built
  against, including the reasoning behind the safety rails and two requirements that were
  revised once the implementation met reality.
- The shared platform findings and the `pm2-probe:status` wire contract live in the
  **`pm2-ops-contract`** repository, because `pm2-alertmanager` is bound by the same contract.

## Development

```bash
npm install
npm run build
npm test                  # unit tests
npm run test:integration  # spins up a real PM2 daemon, breaks an app, asserts the restart
```

The integration harness starts a two-instance cluster app, breaks one instance, and asserts
that only the failing instance is restarted and that the event reaches a separate subscriber
process. It uses an isolated `PM2_HOME` and asserts the socket-path limit up front.

## License

MIT

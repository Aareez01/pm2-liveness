# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First release.

### Added

- **HTTP, TCP and exec probes** with per-app `periodSeconds`, `timeoutSeconds`,
  `failureThreshold`, `successThreshold` and `initialDelaySeconds`. A timeout counts as a
  failure rather than an error to retry.
- **`loopLag` probe** reading the event-loop figure PM2 already publishes. PM2 7 populates
  `Event Loop Latency` for every app with no instrumentation at all, so this works out of
  the box; `metricName` targets a specific metric.
- **Per-instance restart.** A trip restarts only the failing cluster instance, never the
  whole app.
- **Restart budget** (default 3 per 10 minutes) and a **quorum check**, so a shared
  dependency failing cannot take every instance down at once.
- **`action: "none"` by default** — probe and emit events, never restart. The destructive
  mode is opt-in.
- **Cluster addressability guard.** In cluster mode with a shared port PM2 routes to an
  arbitrary worker, so per-instance probing is impossible. The app is refused with the
  three remedies rather than probed on a guess.
- **Instrumentation guard** for `loopLag`: an app with no usable metric is refused, never
  silently passed.
- **`/livez` and `/readyz`** endpoint, disabled by default and loopback-only when enabled.
  Serves cached state, so a load-balancer health check cannot amplify into live probes.
- **`pm2-liveness:status` events** on every state transition, for consumers such as
  `pm2-alertmanager`.
- Configuration via `pm2 set` or a watched sidecar file, validated at boot with the
  offending path named.

### Supported runtimes

Verified against **Node 18, 20, 22, 24 and 26**, and **PM2 7.1.1**. Node 26 (LTS Lithium)
was checked by running the full unit and integration suites on it, including a live PM2
daemon — not merely added to a CI matrix. Node 27 is still alpha and is not a support
target.

### Known limitations

- Configuration **cannot** live in `ecosystem.config.js`. PM2's validator is a whitelist
  and silently discards unknown keys; the README explains this.
- `loopLag` depends on metric names published by the instrumentation layer rather than by
  PM2's API, so they are matched by pattern with an override.

# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-04

### Removed

- **Node 18 and 20 are no longer supported**; `engines.node` is now `>=22`. Both are past
  end of life, and the test runner required by the zod upgrade below cannot execute on
  them. Claiming a version that cannot be run is worse than not claiming it, so the claim
  was dropped rather than left asserted but unverified. `0.1.0` remains available and
  still declares `>=18` for anyone pinned to an older runtime, but it ships the affected
  zod and will not be patched.

### Security

- **zod upgraded from 3.x to 4.6.7** (GHSA-mrhx-c7xc-m3w5, high). zod below 4.6.6
  accumulates one issue object per failing array element with no cap, so a large array
  of invalid values can exhaust memory. `0.1.0` shipped `zod ^3.23.8` and is affected;
  upgrade to `0.2.0`.
- **Array schemas now carry explicit length caps.** The upgrade alone is not sufficient:
  the 4.6.6 fix is an early exit when a *length constraint* fails, so an unconstrained
  array still accumulates unbounded issues on 4.6.7. Measured, 300k failing elements:
  3.25.76 unconstrained 300,000 issues / 97 MB; 4.6.7 unconstrained 300,000 issues /
  137 MB; 4.6.7 with `.max()` 1 issue / 0 MB. Both halves are required.

  This was **not exploitable in this module**: the only zod input is the operator's own
  config file, and anyone who can write it can already set an `exec` probe command,
  which is arbitrary code execution. Fixed so consumers' `npm audit` is clean and the
  parser is bounded regardless of input source.

### Changed

- `vitest` upgraded to 5.x, clearing a critical prototype-pollution advisory in
  `tinypool` (GHSA-5gmw-xhrv-c9v3). Development only; it never shipped.

## [0.1.0] - 2026-10-30

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
- **`action: "none"` by default** - probe and emit events, never restart. The destructive
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
daemon - not merely added to a CI matrix. Node 27 is still alpha and is not a support
target.

### Known limitations

- Configuration **cannot** live in `ecosystem.config.js`. PM2's validator is a whitelist
  and silently discards unknown keys; the README explains this.
- `loopLag` depends on metric names published by the instrumentation layer rather than by
  PM2's API, so they are matched by pattern with an override.

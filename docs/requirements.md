# pm2-probe — Requirements

**Status:** Draft · **Date:** 2026-10-30 · **Repo:** `pm2-probe` (standalone) · **Licence:** MIT

Depends on the shared platform constraints and wire contract, which live in the
**`pm2-ops-contract`** repository (`00-platform-and-contract.md`) because both this module
and `pm2-alertmanager` are bound by them. Read that first.

---

## 1. Problem

PM2 reports a process as `online` whenever its OS process is alive. A Node app with a blocked event
loop, an exhausted connection pool, or one returning 503 to every request is `online` by PM2's
definition and will never be restarted. PM2's only health signals are *crash* (process died) and
*memory ceiling*. There is no active probing.

Every orchestrator that competes for this workload — Kubernetes, ECS, Nomad — treats liveness and
readiness probing as table stakes. This is the single widest capability gap in PM2 for production use,
and it is the keystone of the suite: `pm2-alertmanager` and the later `pm2-release` both consume its
output.

## 2. Goals / Non-goals

**Goals**
- Detect unhealthy-but-alive processes and restart them, per cluster instance.
- Expose aggregate readiness so an external load balancer can route correctly.
- Emit `pm2-probe:status` events (per the shared contract) for other modules.

**Non-goals (v1)**
- Alerting or notification of any kind — that is `pm2-alertmanager`'s job.
- Deploy gating — that is `pm2-release`, Phase 3.
- Metrics export — `pm2-metrics` already serves this well.
- Probing anything that is not a PM2-managed process.

## 3. Functional requirements

### 3.1 Probe types

- **REQ-PR-01** — **HTTP(S) probe.** Configurable method (default `GET`), URL, expected status set
  (default `200-399`), optional response-body regex, optional required headers, optional request
  headers. Must support self-signed TLS via an explicit `insecure` flag (default `false`).
- **REQ-PR-02** — **TCP probe.** Connect to host:port, succeed on established connection, close
  immediately. No data written.
- **REQ-PR-03** — **Exec probe.** Run a command; exit code `0` is pass. Command runs with a hard
  timeout and is killed by process group on expiry. Must not inherit the module's env wholesale —
  pass an explicit env to avoid leaking module config into the probed command.
- **REQ-PR-04** — **Event-loop-lag probe.** Requires the app to be instrumented. Since the module
  cannot measure another process's event loop directly, v1 derives this from `pm2.list()` →
  `monit`/axm metrics where the app uses `@pm2/io`. **If the app is not instrumented, this probe type
  must refuse to start with a clear message** rather than silently always-pass.

### 3.2 Scheduling and state machine

- **REQ-PR-05** — Per-app settings: `periodSeconds` (default 10), `timeoutSeconds` (default 3),
  `failureThreshold` (default 3), `successThreshold` (default 1), `initialDelaySeconds` (default 0).
- **REQ-PR-06** — `initialDelaySeconds` is measured from the instance's `pm_uptime`, not from module
  start, so that a module restart does not grant a long-running app a fresh grace period.
- **REQ-PR-07** — State machine per *instance* (not per app): `starting → healthy ⇄ failing → tripped`.
  Transitions only on crossing `failureThreshold` / `successThreshold` consecutive results.
- **REQ-PR-08** — A timeout counts as a failure, not an error to be retried.
- **REQ-PR-09** — Probes for different instances must run concurrently; a slow probe on one instance
  must not delay another. Scheduling is per-instance with jitter (±10% of period) to avoid thundering
  herds against a shared dependency.
- **REQ-PR-10** — If a probe's own execution throws, that counts as a failure and is logged once per
  transition, not once per tick.

### 3.3 Actions

- **REQ-PR-11** — On reaching `tripped`, restart **the single failing cluster instance** via
  `pm2.restart(pm_id)`, never the whole app. This is the core behavioural requirement.

  **Live-verified.** The walking skeleton broke `pm_id=1` of a 2-instance cluster app; the probe
  tripped after 2 consecutive 503s and restarted only that instance (`↺1`, new pid, uptime reset),
  leaving `pm_id=0` untouched (`↺0`, original pid). Recovery was detected on the next cycle.

- **REQ-PR-11a** — ⚠️ **Per-instance HTTP probing requires per-instance ports.** In PM2 cluster mode
  with a *shared* port, the primary routes each connection to an arbitrary worker, so an HTTP probe
  cannot target a specific instance and `pm2.restart(pm_id)` would be restarting an instance the
  probe never actually tested. The skeleton avoided this with `increment_var: 'PORT'`, which gives
  each instance its own port (verified: `pm_id0=:3100, pm_id1=:3101`).

  Therefore the module MUST detect an app in `cluster` mode with a network probe and no per-instance
  port distinction, and **refuse to probe that app** — logging the reason once per app/topology and
  incrementing a counter — while continuing to probe every other app normally.

  *Revised during implementation.* This originally said "refuse to start". That is wrong twice over:
  a shared port is a **runtime topology** condition, not a config error, so it cannot be caught by
  config validation (REQ-PR-28); and an app scaled into this state *after* boot would crash-loop the
  module under PM2, violating NFR-2. Skipping the one app is the correct blast radius.

  The log message MUST explain the options:
  1. set `increment_var: 'PORT'` so instances bind distinct ports;
  2. use an IPC-based probe (future work) that targets a `pm_id` directly;
  3. set `scope: 'app'` to accept app-level probing, in which case a trip MUST restart the whole app
     rather than guessing an instance.

  Silently probing a shared port and restarting an arbitrary instance is the worst outcome and must
  not be possible.
- **REQ-PR-12** — **Restart budget.** At most N restarts per instance per window (default 3 per 10
  minutes). On exhaustion, stop restarting, enter `tripped-giving-up`, and keep emitting events. A
  probe that restart-loops a broken app forever is worse than no probe.
- **REQ-PR-13** — **Cluster-safety quorum.** Never restart an instance if doing so would leave fewer
  than `minHealthy` instances serving.

  `minHealthy: 'auto'` (the default) resolves to **`0` for a single-instance app** and
  `max(1, floor(instances / 2))` for 2+ instances.

  *Revised during implementation.* This originally read "1, or 50%, whichever is greater". That floor
  means a single-instance app can never be restarted — which is the most common PM2 deployment and
  the exact case the module exists to serve. A lone instance has no quorum to protect, so the floor
  is 0 there. An explicit numeric `minHealthy` always wins over `auto`.
- **REQ-PR-14** — Post-restart, suppress probing for that instance until `initialDelaySeconds` elapses
  from its new `pm_uptime`.
- **REQ-PR-15** — `action: "none"` mode — probe and emit events but never restart. This is the
  recommended first-run setting and must be prominent in the README.

### 3.4 Readiness vs liveness

- **REQ-PR-16** — Two independent probe definitions per app: `liveness` (failure → restart) and
  `readiness` (failure → mark not-ready, **never** restart).
- **REQ-PR-17** — Readiness state is advisory only in v1; it feeds the HTTP endpoint and events.

### 3.5 HTTP endpoint

- **REQ-PR-18** — Optional built-in HTTP server exposing `/livez` and `/readyz`.
- **REQ-PR-19** — `/readyz` returns `200` when at least `minHealthy` instances of every configured app
  are ready; `503` otherwise. Body is a JSON per-app summary.
- **REQ-PR-20** — **Disabled by default.** When enabled, binds `127.0.0.1` by default. Binding to a
  non-loopback address requires an explicit config value, and the README must state the exposure
  clearly. (Open question Q3 in the platform doc.)
- **REQ-PR-21** — Endpoint must respond in under 50 ms by serving cached state — it must never
  trigger a live probe, or a load balancer health check becomes an amplification vector.

### 3.6 Events

- **REQ-PR-22** — Emit `pm2-probe:status` per the contract on every **transition** (`pass`→`fail`,
  `fail`→`recovered`), never on every tick. Tick-level noise is the consumer's problem to not have.
- **REQ-PR-23** — Emit with `action` set to what the probe actually did, so a consumer can distinguish
  "failed and restarted" from "failed and budget exhausted".
- **REQ-PR-24** — Event emission must be non-blocking and must never delay or fail a probe cycle.

### 3.7 Configuration

Per F1, a `probe` block in `ecosystem.config.js` **does not work**. Two supported channels:

- **REQ-PR-25** — **Module config (primary).** A JSON blob under one key:
  ```
  pm2 set pm2-probe:apps '{"api":{"liveness":{"http":"http://127.0.0.1:3000/health","periodSeconds":10}}}'
  ```
  Per F3 this restarts the module automatically.
- **REQ-PR-26** — **Sidecar file (recommended for non-trivial setups).**
  `pm2 set pm2-probe:configFile /etc/pm2-probe/config.yaml`. YAML or JSON. The module watches the file
  (debounced, 1 s) and reloads without restarting.
- **REQ-PR-27** — Sidecar file takes precedence when both are present, and the module logs which one
  it used at boot.
- **REQ-PR-28** — Per NFR-8, validate the whole config at boot against a schema and refuse to start on
  error, naming the offending path (e.g. `apps.api.liveness.periodSeconds: expected number, got "10s"`).
- **REQ-PR-29** — **Document F1 explicitly in the README.** If a user puts a `probe` key in their
  ecosystem file, PM2 discards it silently and the user will blame this module. A README section
  ("Why can't I configure this in ecosystem.config.js?") is a hard requirement.
- **REQ-PR-30** — Apps with no probe configured are ignored entirely — no default probing.
- **REQ-PR-30a** — Resolve each instance's probe target port from `pm2.list()`, checking **both**
  `pm2_env.PORT` and `pm2_env.env.PORT` (live-verified: both were populated, but which one is set
  depends on how the app was started). If neither resolves, log once per instance and skip it rather
  than probing a guessed port.
- **REQ-PR-30b** — Per F9, document in the troubleshooting guide that a `PM2_HOME` longer than ~90
  characters wedges PM2 entirely with no error. Integration tests MUST assert the socket path length
  in setup and fail fast.

### 3.8 Operability

- **REQ-PR-31** — Structured JSON logs at `info` by default, one line per state transition. Never log
  per successful tick at default level.
- **REQ-PR-32** — Expose via `pmx.probe()`: probes configured, probes passing, probes failing,
  restarts issued, restart-budget exhaustions, last probe latency.
- **REQ-PR-33** — Never probe itself or other PM2 modules (`pm2_env.pmx_module === true`).
- **REQ-PR-34** — Reconcile against `pm2.list()` every 30 s so apps started, stopped, or scaled after
  module boot are picked up without a restart.

## 4. Acceptance criteria

1. An app with a `/health` route that is made to return 503 is restarted within
   `failureThreshold × periodSeconds` (+1 tick tolerance), and only that instance.
   *(Already demonstrated by the walking skeleton — promote that script into the integration suite.)*
1a. A cluster-mode app whose instances share a port is **skipped with a logged reason** naming the
   three remedies (REQ-PR-11a), while other configured apps keep being probed and the module stays up.
2. A 4-instance cluster where all 4 fail simultaneously, with `minHealthy: 2`, restarts at most 2
   concurrently.
3. An app whose health endpoint hangs (never responds) is restarted — proving timeout-as-failure.
4. With `action: "none"`, no restart ever occurs but events are still emitted.
5. Restart budget exhaustion stops restarts and is visible in `pm2 monit` counters.
6. `pm2 set pm2-probe:apps '<invalid json>'` fails at boot with a message naming the problem.
7. Killing and restarting the module does not grant a long-running app a fresh `initialDelaySeconds`.
8. Module steady-state RSS stays under 60 MB while probing 50 instances (NFR-1).

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Probe restarts a healthy app due to a flaky dependency | Self-inflicted outage | REQ-PR-12 budget, REQ-PR-13 quorum, REQ-PR-15 default-off action |
| Event-loop-lag probe needs app instrumentation | Advertised feature doesn't work out of the box | REQ-PR-04 refuses to start rather than always-passing |
| Users expect ecosystem.config.js and hit F1 | Bad first impression, bug reports | REQ-PR-29 README section + loud validation |
| `/readyz` exposed publicly | Information disclosure | REQ-PR-20 off by default, loopback-only |

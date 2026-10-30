/**
 * The pm2-probe -> consumer wire contract.
 *
 * This is a WIRE contract, not a shared library type: pm2-alertmanager lives in a
 * separate repo and carries its own copy. The normative definition is this file and
 * the README section it is mirrored into. See requirements/00-platform-and-contract.md.
 *
 * Transport (verified against PM2 7.1.1): a PM2-managed process calling
 *   process.send({ type, data })
 * has `data` re-emitted on the global bus under `type` as the event name, and the
 * daemon forwards it to every external launchBus subscriber.
 *
 * Two constraints follow from the PM2 source:
 *  1. `type` and `data` must BOTH be truthy, or it degrades to a generic `process:msg`.
 *  2. The `process` envelope PM2 attaches identifies the EMITTER (pm2-probe), not the
 *     subject. All subject identity must therefore live inside the payload - which is
 *     why `app` and `pm_id` are required fields.
 */

export const PROBE_STATUS_EVENT = 'pm2-probe:status';

/** Bump only on a breaking change: removing a field or changing its type. */
export const CONTRACT_VERSION = 1;

export type ProbeState = 'pass' | 'fail' | 'recovered';
export type ProbeKind = 'liveness' | 'readiness';
export type ProbeType = 'http' | 'tcp' | 'exec' | 'loop-lag';
export type ProbeAction = 'restart' | 'none';

export interface ProbeStatusEvent {
  /** Contract version. Consumers MUST ignore payloads whose version they don't know. */
  v: number;
  state: ProbeState;
  app: string;
  pm_id: number;
  probe: ProbeType;
  probe_kind: ProbeKind;
  at: string;

  namespace?: string;
  reason?: string;
  consecutive?: number;
  threshold?: number;
  latency_ms?: number;
  /** What the probe actually DID - lets a consumer tell "failed and restarted" from
   *  "failed but the restart budget was exhausted". */
  action?: ProbeAction;
  rev?: string | null;
  host?: string;
}

const STATES: readonly string[] = ['pass', 'fail', 'recovered'];
const KINDS: readonly string[] = ['liveness', 'readiness'];
const TYPES: readonly string[] = ['http', 'tcp', 'exec', 'loop-lag'];

/**
 * Runtime validator for consumers. Checks only the required fields (contract rule C4)
 * and deliberately tolerates unknown extra fields (C3).
 */
export function isProbeStatusEvent(x: unknown): x is ProbeStatusEvent {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.app === 'string' &&
    typeof e.pm_id === 'number' &&
    typeof e.at === 'string' &&
    typeof e.state === 'string' && STATES.includes(e.state) &&
    typeof e.probe === 'string' && TYPES.includes(e.probe) &&
    typeof e.probe_kind === 'string' && KINDS.includes(e.probe_kind)
  );
}

/** True when this consumer understands the payload's version (contract rule C1). */
export function isSupportedVersion(e: ProbeStatusEvent): boolean {
  return e.v === CONTRACT_VERSION;
}

import { PROBE_STATUS_EVENT, CONTRACT_VERSION, ProbeStatusEvent } from './contract';
import { log } from '../log';

/**
 * Emission must be non-blocking and must never delay or fail a probe cycle.
 * If we are not running under PM2 there is no bus to emit to - warn once, carry on.
 */
let warned = false;

export function emitProbeStatus(e: Omit<ProbeStatusEvent, 'v'>): void {
  const payload: ProbeStatusEvent = { v: CONTRACT_VERSION, ...e };
  try {
    if (typeof process.send !== 'function') {
      if (!warned) {
        warned = true;
        log.warn('process.send unavailable - not running under PM2, events disabled');
      }
      return;
    }
    // Both `type` and `data` must be truthy or PM2 degrades this to `process:msg`.
    process.send({ type: PROBE_STATUS_EVENT, data: payload });
  } catch (err) {
    log.warn('failed to emit probe status', { error: (err as Error).message });
  }
}

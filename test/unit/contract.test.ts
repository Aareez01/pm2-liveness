import { describe, it, expect } from 'vitest';
import {
  isProbeStatusEvent, isSupportedVersion, CONTRACT_VERSION, ProbeStatusEvent,
} from '../../src/events/contract';

const valid: ProbeStatusEvent = {
  v: CONTRACT_VERSION, state: 'fail', app: 'api', pm_id: 1,
  probe: 'http', probe_kind: 'liveness', at: new Date().toISOString(),
};

describe('wire contract', () => {
  it('accepts a payload with only the required fields (C4)', () => {
    expect(isProbeStatusEvent(valid)).toBe(true);
  });

  it('tolerates unknown extra fields (C3)', () => {
    expect(isProbeStatusEvent({ ...valid, somethingNew: 42 })).toBe(true);
  });

  it('rejects payloads missing a required field', () => {
    const { app, ...without } = valid;
    expect(isProbeStatusEvent(without)).toBe(false);
  });

  it('rejects unknown enum values', () => {
    expect(isProbeStatusEvent({ ...valid, state: 'exploded' })).toBe(false);
    expect(isProbeStatusEvent({ ...valid, probe_kind: 'vibes' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isProbeStatusEvent(null)).toBe(false);
    expect(isProbeStatusEvent('nope')).toBe(false);
  });

  it('flags versions this consumer does not understand (C1)', () => {
    expect(isSupportedVersion(valid)).toBe(true);
    expect(isSupportedVersion({ ...valid, v: 99 })).toBe(false);
  });
});

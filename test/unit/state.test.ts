import { describe, it, expect } from 'vitest';
import { InstanceHealth } from '../../src/core/state';

describe('InstanceHealth', () => {
  it('does not trip before the failure threshold', () => {
    const h = new InstanceHealth(3, 1);
    expect(h.record(false)).toBeNull();
    expect(h.record(false)).toBeNull();
    expect(h.record(false)?.to).toBe('tripped');
  });

  it('requires CONSECUTIVE failures - a pass resets the counter', () => {
    const h = new InstanceHealth(3, 1);
    h.record(false);
    h.record(false);
    h.record(true);
    expect(h.record(false)).toBeNull();
    expect(h.record(false)).toBeNull();
    expect(h.record(false)?.to).toBe('tripped');
  });

  it('emits no event for the first healthy result', () => {
    const h = new InstanceHealth(3, 1);
    expect(h.record(true)).toBeNull();
    expect(h.isHealthy).toBe(true);
  });

  it('emits a recovery transition only after a trip', () => {
    const h = new InstanceHealth(1, 2);
    expect(h.record(false)?.to).toBe('tripped');
    expect(h.record(true)).toBeNull();           // successThreshold is 2
    expect(h.record(true)?.to).toBe('healthy');
  });

  it('stays quiet while already tripped', () => {
    const h = new InstanceHealth(1, 1);
    expect(h.record(false)?.to).toBe('tripped');
    expect(h.record(false)).toBeNull();
    expect(h.record(false)).toBeNull();
  });

  it('can trip again after a restart resets it', () => {
    const h = new InstanceHealth(1, 1);
    expect(h.record(false)?.to).toBe('tripped');
    h.resetAfterRestart();
    expect(h.record(false)?.to).toBe('tripped');
  });
});

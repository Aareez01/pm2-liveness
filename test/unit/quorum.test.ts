import { describe, it, expect } from 'vitest';
import { canRestart, effectiveMinHealthy } from '../../src/core/quorum';

describe('effectiveMinHealthy', () => {
  it("'auto' is 0 for a single instance so it can still be restarted", () => {
    expect(effectiveMinHealthy(1, 'auto')).toBe(0);
  });

  it("'auto' protects half, at least one, for clusters", () => {
    expect(effectiveMinHealthy(2, 'auto')).toBe(1);
    expect(effectiveMinHealthy(4, 'auto')).toBe(2);
    expect(effectiveMinHealthy(5, 'auto')).toBe(2);
  });

  it('respects an explicit floor', () => {
    expect(effectiveMinHealthy(4, 0)).toBe(0);
    expect(effectiveMinHealthy(4, 3)).toBe(3);
  });
});

describe('canRestart', () => {
  it('allows restarting a single-instance app under auto', () => {
    expect(canRestart({ healthy: 1, restarting: 0, totalInstances: 1, minHealthy: 'auto' }))
      .toBe(true);
  });

  it('blocks a restart that would breach the floor', () => {
    // 4 instances, floor 2, only 2 serving -> restarting one leaves 1
    expect(canRestart({ healthy: 2, restarting: 0, totalInstances: 4, minHealthy: 'auto' }))
      .toBe(false);
  });

  it('allows a restart that keeps the floor', () => {
    expect(canRestart({ healthy: 4, restarting: 0, totalInstances: 4, minHealthy: 'auto' }))
      .toBe(true);
  });

  it('counts instances already restarting against the floor', () => {
    expect(canRestart({ healthy: 4, restarting: 2, totalInstances: 4, minHealthy: 2 }))
      .toBe(false);
  });

  it('a floor of 0 always permits', () => {
    expect(canRestart({ healthy: 1, restarting: 5, totalInstances: 4, minHealthy: 0 }))
      .toBe(true);
  });
});

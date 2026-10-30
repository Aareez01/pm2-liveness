import { describe, it, expect } from 'vitest';
import { RestartBudget } from '../../src/core/budget';

describe('RestartBudget', () => {
  it('allows up to max within the window, then refuses', () => {
    const b = new RestartBudget(3, 600_000);
    const t = 1_000_000;
    expect(b.tryConsume(t)).toBe(true);
    expect(b.tryConsume(t + 1)).toBe(true);
    expect(b.tryConsume(t + 2)).toBe(true);
    expect(b.tryConsume(t + 3)).toBe(false);
    expect(b.remaining(t + 3)).toBe(0);
  });

  it('frees capacity as the window slides', () => {
    const b = new RestartBudget(2, 10_000);
    const t = 1_000_000;
    expect(b.tryConsume(t)).toBe(true);
    expect(b.tryConsume(t + 1_000)).toBe(true);
    expect(b.tryConsume(t + 2_000)).toBe(false);
    // first stamp has aged out
    expect(b.tryConsume(t + 11_000)).toBe(true);
  });

  it('a zero budget refuses everything', () => {
    const b = new RestartBudget(0, 1000);
    expect(b.tryConsume(1)).toBe(false);
  });
});

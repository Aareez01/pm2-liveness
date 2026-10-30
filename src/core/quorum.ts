/**
 * Cluster-safety quorum (REQ-PR-13): never restart an instance if doing so would drop
 * the serving count below the floor. Without this, a dependency outage that fails every
 * instance at once would take the whole app down.
 */

/**
 * 'auto' resolves to 0 for a single-instance app - there is no quorum to protect, and a
 * floor of 1 would mean such an app could never be restarted at all, which defeats the
 * point of the module. For 2+ instances it protects half, at least one.
 */
export function effectiveMinHealthy(instances: number, configured: number | 'auto'): number {
  if (configured !== 'auto') return configured;
  return instances <= 1 ? 0 : Math.max(1, Math.floor(instances / 2));
}

export interface QuorumInput {
  /** Instances currently serving, including the candidate we want to restart. */
  healthy: number;
  /** Instances already restarting and therefore not serving. */
  restarting: number;
  totalInstances: number;
  minHealthy: number | 'auto';
}

/** True when restarting one more instance still leaves at least `minHealthy` serving. */
export function canRestart(i: QuorumInput): boolean {
  const floor = effectiveMinHealthy(i.totalInstances, i.minHealthy);
  if (floor <= 0) return true;
  const servingAfter = i.healthy - i.restarting - 1;
  return servingAfter >= floor;
}

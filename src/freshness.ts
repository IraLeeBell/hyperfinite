/**
 * Shared deterministic freshness-window checks used by the pre-App readback
 * comparators (`src/app-registration-plan.ts`, `src/administrator-plan.ts`).
 *
 * Neither function here reads the system clock, environment, or network:
 * `now` must always be supplied by the caller from its own trusted,
 * already-authenticated time source, so evaluation stays deterministic and
 * side-effect free, consistent with the rest of this repository's kernel and
 * policy evaluation.
 */

export interface FreshnessWindow {
  readonly now: string;
  readonly maxAgeMs: number;
}

export interface FreshnessIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Reports drift when `observedAt` cannot be parsed, lies in the future
 * relative to `freshness.now`, or is older than `freshness.maxAgeMs`.
 */
export function checkObservationFreshness(
  path: string,
  observedAt: string,
  freshness: FreshnessWindow
): readonly FreshnessIssue[] {
  const nowMs = Date.parse(freshness.now);
  if (Number.isNaN(nowMs)) {
    return [{ path: "/freshness/now", message: "freshness.now is not a valid timestamp" }];
  }
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
    return [{ path, message: "observation timestamp is not a valid timestamp" }];
  }
  const ageMs = nowMs - observedMs;
  if (ageMs < 0) {
    return [
      { path, message: "observation timestamp is in the future relative to the supplied freshness window" }
    ];
  }
  if (ageMs > freshness.maxAgeMs) {
    return [
      {
        path,
        message: `observation is ${ageMs}ms old, exceeding the maximum age ${freshness.maxAgeMs}ms`
      }
    ];
  }
  return [];
}

/**
 * Reports drift when `expiresAt` cannot be parsed or has already lapsed
 * relative to `now`.
 */
export function checkNotExpired(
  path: string,
  expiresAt: string,
  now: string
): readonly FreshnessIssue[] {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return [{ path: "/freshness/now", message: "now is not a valid timestamp" }];
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return [{ path, message: "expiry timestamp is not a valid timestamp" }];
  }
  if (nowMs > expiresMs) {
    return [{ path, message: "has expired relative to the supplied freshness window" }];
  }
  return [];
}

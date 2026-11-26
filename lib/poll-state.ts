/** Pure polling rules used by usePolledCall. */

export const RECONNECT_AFTER_FAILURES = 2;

export function isReconnecting(consecutiveFailures: number): boolean {
  return consecutiveFailures >= RECONNECT_AFTER_FAILURES;
}

/**
 * Stop once a fetch has shown the call as ended and one further fetch has
 * confirmed it (the extra fetch picks up events written right after ended_at,
 * such as the alert). `endedFetches` counts successful fetches that saw ended_at.
 */
export function shouldKeepPolling(endedFetches: number): boolean {
  return endedFetches < 2;
}

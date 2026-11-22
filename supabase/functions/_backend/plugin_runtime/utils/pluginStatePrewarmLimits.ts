// Dependency-free limits shared by the regional prewarm route and the API
// worker that calls it, so the two sides cannot drift apart.

/**
 * Apps per prewarm call. Each app reads up to 17 documents, so this keeps one
 * call well inside the per-invocation KV and R2 operation limits.
 */
export const PREWARM_MAX_APPS = 10
/** Whole-call budget of the regional route. */
export const PREWARM_CALL_BUDGET_MS = 6000
/** API worker timeout per call: the route budget plus room for the round trip. */
export const PREWARM_CALL_TIMEOUT_MS = PREWARM_CALL_BUDGET_MS + 2000

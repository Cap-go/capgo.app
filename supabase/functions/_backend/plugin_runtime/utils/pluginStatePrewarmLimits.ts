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
/**
 * Provider and cache operations one call may start, across all its apps and
 * retries: below the 1,000 operations a Worker invocation may make.
 */
export const PREWARM_MAX_OPERATIONS = 900
/**
 * Manifest documents loaded at once per call, across all its apps. A manifest
 * can approach 4 MiB (the sync's MANIFEST_MEMORY_LIMIT_BYTES), and a load holds
 * its parsed value plus serialization and cache-write buffers, so this keeps a
 * call far below the Worker's 128 MiB memory limit.
 */
export const PREWARM_MANIFEST_CONCURRENCY = 2
/** Kept free at the end of each budget so a cleanup delete still fits. */
export const PREWARM_CLEANUP_RESERVE_MS = 300

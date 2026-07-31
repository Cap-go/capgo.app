/**
 * DEPRECATED — do not run.
 *
 * `supabase/functions/_backend/plugin_runtime/` is now the source of truth for
 * plugin request-path code. Re-running a closure copy would delete the isolate
 * and overwrite hand-tuned files.
 *
 * Use `bun run check:plugin-runtime` to enforce the import boundary instead.
 */
console.error(`isolate_plugin_runtime.mjs is disabled.

plugin_runtime/ is the source of truth. Do not regenerate it from a copy.
Run: bun run check:plugin-runtime
`)
process.exit(1)

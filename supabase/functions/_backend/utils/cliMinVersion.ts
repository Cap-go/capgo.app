/**
 * Minimum @capgo/cli version Capgo still supports.
 *
 * GET /private/config exposes this as `minCliVersion` + `minCliVersionReason`.
 * The CLI refuses to continue when it is older than this floor.
 *
 * CLI compatibility tests must pin to this exact version (see AGENTS.md
 * "CLI Minimum Version"). Workspace `tests/cli*` coverage is the current CLI
 * and does not replace that pin.
 *
 * Agents MUST ask before changing these values. Security-related breaks may
 * raise the floor; non-security / additive changes usually should not.
 */
export const MIN_CLI_VERSION = '8.90.1'

export const MIN_CLI_VERSION_REASON = 'Capgo no longer accepts direct database (PostgREST) access from the CLI. CLIs older than 8.90.1 rely on it and can no longer upload bundles or manage apps.'

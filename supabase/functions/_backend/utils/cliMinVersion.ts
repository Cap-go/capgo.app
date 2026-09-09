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
export const MIN_CLI_VERSION = '8.42.3'

export const MIN_CLI_VERSION_REASON = 'Oldest CLI version Capgo still tests against the current API. Older CLIs can fail on uploads, auth, or encryption.'

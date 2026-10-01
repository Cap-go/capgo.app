import type { Context } from 'hono'
import { canParse, lessThan, parse } from '@std/semver'
import { quickError } from './hono.ts'

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

// Parsed once at import. A malformed MIN_CLI_VERSION throws here at deploy time
// rather than silently disabling the gate on every request.
const MIN_CLI_SEMVER = parse(MIN_CLI_VERSION)

/**
 * Reject a bundle upload from a @capgo/cli older than MIN_CLI_VERSION.
 *
 * The floor is otherwise advisory: GET /private/config publishes it and the CLI
 * enforces it, so a CLI too old to read that value never checks it. Such CLIs
 * finalize uploads by writing app_versions.manifest jsonb, which the
 * check_encrypted_bundle_on_insert trigger blocks after the files already
 * reached R2. Calling this from the presigned upload-link request rejects that
 * doomed upload up front, with a message the user can act on.
 *
 * This is a best-effort early exit, not the safety net. Uploads that skip the
 * presigned link (TUS) are not gated here; they still fail at the trigger, which
 * now carries the same upgrade message. Correctness comes from the trigger, so
 * requests without a parseable `x-cli-version` header are left alone here to
 * spare non-CLI API clients and self-hosted tooling.
 */
export function assertUploadCliVersionSupported(c: Context) {
  const cliVersion = c.req.header('x-cli-version')?.trim()
  if (!cliVersion || !canParse(cliVersion))
    return
  if (!lessThan(parse(cliVersion), MIN_CLI_SEMVER))
    return
  quickError(
    400,
    'cli_version_too_old',
    `Your @capgo/cli (${cliVersion}) is too old to upload bundles. Update it: run npx @capgo/cli@latest, then upload again.`,
    { minCliVersion: MIN_CLI_VERSION, cliVersion },
  )
}

/**
 * Zero-dependency fast predicate for update request bodies.
 *
 * Generated from the zod-compiler AOT `__fc_3` check for
 * `update_request.zod.ts` (`bun run plugin:schemas:compile`), then extracted
 * so Deno/Supabase and the Cloudflare plugin worker never import `zod`.
 *
 * Regenerate workflow:
 * 1) edit `update_request.zod.ts`
 * 2) `bun run plugin:schemas:compile`
 * 3) copy the compiled `__fc_3` body into `isUpdateRequestBody` below
 * 4) re-run `bun run bench:plugin-validation-cpu` to confirm parity
 */

const reverseDomainRegex = /^[a-z0-9]+(\.[\w-]+)+$/i
const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const commonSemverRegex = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export function isUpdateRequestBody(input: unknown): boolean {
  return typeof input === 'object'
    && input !== null
    && !Array.isArray(input)
    && typeof (input as Record<string, unknown>).app_id === 'string'
    && reverseDomainRegex.test((input as Record<string, unknown>).app_id as string)
    && typeof (input as Record<string, unknown>).device_id === 'string'
    && ((input as Record<string, unknown>).device_id as string).length <= 36
    && deviceIdRegex.test((input as Record<string, unknown>).device_id as string)
    && typeof (input as Record<string, unknown>).version_name === 'string'
    && ((input as Record<string, unknown>).version_name as string).length >= 1
    && typeof (input as Record<string, unknown>).version_build === 'string'
    && ((input as Record<string, unknown>).version_build as string).length >= 1
    && typeof (input as Record<string, unknown>).is_emulator === 'boolean'
    && typeof (input as Record<string, unknown>).is_prod === 'boolean'
    && (
      (input as Record<string, unknown>).platform === 'ios'
      || (input as Record<string, unknown>).platform === 'android'
      || (input as Record<string, unknown>).platform === 'electron'
    )
    && typeof (input as Record<string, unknown>).plugin_version === 'string'
    && commonSemverRegex.test((input as Record<string, unknown>).plugin_version as string)
    && (
      (input as Record<string, unknown>).defaultChannel === undefined
      || typeof (input as Record<string, unknown>).defaultChannel === 'string'
    )
    && (
      (input as Record<string, unknown>).install_source === undefined
      || (
        typeof (input as Record<string, unknown>).install_source === 'string'
        && ((input as Record<string, unknown>).install_source as string).length <= 64
      )
    )
    && (
      (input as Record<string, unknown>).key_id === undefined
      || (
        typeof (input as Record<string, unknown>).key_id === 'string'
        && ((input as Record<string, unknown>).key_id as string).length <= 20
      )
    )
}

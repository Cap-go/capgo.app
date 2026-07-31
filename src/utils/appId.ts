// Keep in sync with supabase/functions/_backend/utils/utils.ts reverseDomainRegex.
const reverseDomainRegex = /^[a-z0-9]+(?:\.[\w-]+)+$/i

export function isValidAppId(appId: string): boolean {
  if (!appId)
    return false

  return reverseDomainRegex.test(appId)
}

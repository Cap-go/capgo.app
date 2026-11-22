import { TERMINAL_EGRESS_ALLOWLIST } from './constants.ts'

export function isEgressHostAllowed(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host)
    return false
  return TERMINAL_EGRESS_ALLOWLIST.some((allowed) => {
    if (allowed.startsWith('*.'))
      return host.endsWith(allowed.slice(1)) || host === allowed.slice(2)
    return host === allowed
  })
}
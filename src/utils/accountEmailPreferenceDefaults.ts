export function defaultAccountEmailPref(key: string): boolean {
  return key !== 'security_updates'
}

export function resolveAccountEmailPref(
  prefs: Record<string, boolean | undefined>,
  key: string,
): boolean {
  return prefs[key] ?? defaultAccountEmailPref(key)
}

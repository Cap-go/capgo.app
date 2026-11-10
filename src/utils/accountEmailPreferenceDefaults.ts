export function defaultAccountEmailPref(key: string): boolean {
  return key !== 'security_updates'
}

export function resolveAccountEmailPref(
  prefs: Partial<Record<string, boolean>>,
  key: string,
): boolean {
  return prefs[key] ?? defaultAccountEmailPref(key)
}

/** Build opt-out payload for the public email preferences form (opt-out only). */
export function buildPublicEmailOptOutPreferences(
  preferences: Record<string, boolean>,
  unsubscribeAll: boolean,
  keys: readonly string[],
): Record<string, boolean> {
  return Object.fromEntries(
    keys
      .filter(key => unsubscribeAll || preferences[key] === false)
      .map(key => [key, false]),
  )
}

/** Default toggles on the public form (all on). Opt-out saves must not change prefs the user left untouched. */
export function defaultPublicEmailFormPreferences(keys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map(key => [key, true]))
}

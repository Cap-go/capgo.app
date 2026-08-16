function normalized(value?: string): string | undefined {
  return value?.trim() || undefined
}

export function resolveLoginCommandApiKey(positional?: string, option?: string): string | undefined {
  return normalized(option) ?? normalized(positional)
}

export function resolveInitCommandInput(positionalKey?: string, positionalAppId?: string, optionKey?: string) {
  const flagKey = normalized(optionKey)
  const legacyKey = normalized(positionalKey)
  if (flagKey) {
    return {
      apikey: flagKey,
      appId: normalized(positionalAppId) ?? legacyKey,
      explicitApiKey: true,
    }
  }

  return {
    apikey: legacyKey,
    appId: normalized(positionalAppId),
    explicitApiKey: Boolean(legacyKey),
  }
}

export function withOptionalManifestSelect<TBase extends Record<string, any>, TManifest>(
  baseSelect: TBase,
  includeManifest: boolean,
  manifestSelect: TManifest,
): TBase & { manifestEntries?: TManifest } {
  if (includeManifest)
    return { ...baseSelect, manifestEntries: manifestSelect }

  return baseSelect as TBase & { manifestEntries?: TManifest }
}

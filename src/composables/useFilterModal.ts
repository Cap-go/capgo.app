export function createClearedFilters(filters: Record<string, boolean> | undefined): Record<string, boolean> {
  return Object.fromEntries(
    Object.keys(filters ?? {}).map(key => [key, false]),
  ) as Record<string, boolean>
}

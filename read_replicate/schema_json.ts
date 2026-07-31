export function sortJson(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortJson)

  if (!value || typeof value !== 'object')
    return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? 'undefined'
}

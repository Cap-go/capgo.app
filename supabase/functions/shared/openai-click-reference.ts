/** OpenAI requires the original opaque reference, not a hash or normalized value. */
export function normalizeOpenAIClickReference(value: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex -- reject control characters in opaque external identifiers
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u0020\u007f]/.test(value) ? value : undefined
}

export function slugifyOnboardingSegment(value: string, fallback = 'app') {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '.')

  return slug
    .replace(/^\./g, '')
    .replace(/\.$/g, '')
    || fallback
}

export function trimTrailingDots(value: string) {
  let normalized = value.trim()
  while (normalized.endsWith('.'))
    normalized = normalized.slice(0, -1)
  return normalized
}

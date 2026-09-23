const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const DOMAIN_SUFFIX_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i
const DOMAIN_CANDIDATE_PATTERN = /(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?/giu

function isDomainCandidate(candidate: string) {
  try {
    const url = new URL(`https://${candidate}`)
    const labels = url.hostname.replace(/\.$/u, '').split('.')
    const suffix = labels.at(-1) ?? ''
    return labels.length > 1
      && labels.every(label => DOMAIN_LABEL_PATTERN.test(label))
      && DOMAIN_SUFFIX_PATTERN.test(suffix)
  }
  catch {
    return false
  }
}

export function containsDomainName(value: string) {
  return Array.from(value.matchAll(DOMAIN_CANDIDATE_PATTERN), ([candidate]) => candidate)
    .some(isDomainCandidate)
}

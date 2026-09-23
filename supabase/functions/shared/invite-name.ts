const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const DOMAIN_SUFFIX_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i

function stripSurroundingPunctuation(value: string) {
  return value
    .replace(/^["'([{<]+/u, '')
    .replace(/["')\]}>!,;:]+$/u, '')
    .replace(/\.$/u, '')
}

function isDomainToken(value: string) {
  const token = stripSurroundingPunctuation(value)
  if (!token.includes('.') && !URL_SCHEME_PATTERN.test(token))
    return false

  try {
    const url = new URL(URL_SCHEME_PATTERN.test(token) ? token : `https://${token}`)
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
  return value.trim().split(/\s+/u).some(isDomainToken)
}

// src/build/prescan/checks/ios-plist-read.ts
//
// Shared, value-typed readers for iOS Info.plist / entitlements XML. Targeted
// regexes are deliberate: plist sibling order is lost in object-mode XML
// parsers, so full-tree parsing buys nothing for the shallow keys the prescan
// checks inspect, and avoids a parser dependency entirely.
//
// Every reader is pure and NEVER throws — it returns null/[]/false on a missing
// key or malformed input. Key regexes are built with escapeRegex so a key that
// contains regex metacharacters (e.g. dotted reverse-DNS keys) can never make
// the pattern invalid.

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Top-level `<key>K</key><string>V</string>` value, or null when absent.
 * V is returned verbatim, including an unresolved `$(VAR)` build-variable
 * reference — callers run it through resolvePlistValue before validating.
 */
export function plistString(raw: string, key: string): string | null {
  const re = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<string>([\\s\\S]*?)</string>`)
  return raw.match(re)?.[1] ?? null
}

/**
 * Boolean for `<key>K</key>\s*<true/>|<false/>`. Returns null when the key is
 * absent OR maps to a non-bool value — null is meaningfully distinct from false
 * (e.g. UIRequiresFullScreen absent vs. explicitly false).
 */
export function plistBool(raw: string, key: string): boolean | null {
  const re = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<(true|false)\\s*/>`)
  const m = raw.match(re)
  if (!m)
    return null
  return m[1] === 'true'
}

/** Presence-only check for a `<key>K</key>` element. */
export function plistHasKey(raw: string, key: string): boolean {
  return raw.includes(`<key>${key}</key>`)
}

/**
 * The `<string>` children of `<key>K</key>\s*<array>...</array>`, or [] when the
 * key is absent / not an array. Non-greedy so the first `</array>` wins. Note
 * that the key match is anchored on `</key>`, so a suffixed key such as
 * `K~ipad` is NOT matched by a request for the plain `K` (and vice-versa).
 */
export function plistArrayStrings(raw: string, key: string): string[] {
  const re = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<array>([\\s\\S]*?)</array>`)
  const block = raw.match(re)?.[1]
  if (block === undefined)
    return []
  const out: string[] = []
  for (const m of block.matchAll(/<string>([\s\S]*?)<\/string>/g))
    out.push(m[1].trim())
  return out
}

/**
 * Inner text of `<key>K</key>\s*<dict>...</dict>`, or null when the key is
 * absent. Returns the FULL balanced dict: it scans `<dict>` / `</dict>` depth
 * from the opening dict to its matching close, so arbitrarily nested dicts are
 * captured intact. This matters for keys like NSAppTransportSecurity, where a
 * nested NSExceptionDomains dict appearing BEFORE a sibling such as
 * NSAllowsArbitraryLoads would otherwise truncate the block at the first
 * `</dict>` and hide the sibling. Used to scope reads such as
 * NSAppTransportSecurity. Pure; returns null on a missing key or an unbalanced
 * (malformed) dict.
 */
export function plistDictBlock(raw: string, key: string): string | null {
  // Locate the opening `<dict>` that immediately follows the key.
  const openRe = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<dict>`)
  const openMatch = raw.match(openRe)
  if (openMatch?.index === undefined)
    return null
  const innerStart = openMatch.index + openMatch[0].length

  // Walk forward tracking nesting depth so the matching `</dict>` wins, not the
  // first one. depth starts at 1 for the opening dict already consumed.
  const tagRe = /<dict>|<\/dict>/g
  tagRe.lastIndex = innerStart
  let depth = 1
  for (let m = tagRe.exec(raw); m !== null; m = tagRe.exec(raw)) {
    if (m[0] === '<dict>') {
      depth++
    }
    else {
      depth--
      if (depth === 0)
        return raw.slice(innerStart, m.index)
    }
  }
  // Unbalanced — no matching close. Mirror the other readers' "skip" contract.
  return null
}

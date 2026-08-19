/**
 * Escape a value for safe CSV output.
 *
 * - Formats `Date` as ISO string.
 * - Mitigates spreadsheet formula injection by prefixing suspicious values with `'`.
 * - Quotes and escapes values per RFC 4180-style rules.
 */
function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined)
    return ''

  let str: string
  if (value instanceof Date)
    str = value.toISOString()
  else if (typeof value === 'string')
    str = value
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    str = String(value)
  else
    str = JSON.stringify(value)

  // Mitigate CSV/Excel formula injection: prefix values that could be interpreted
  // as formulas when opened in spreadsheet applications.
  const safeStr = (/^[=+\-@]/.test(str) || str.startsWith('\t')) ? `'${str}` : str

  // Quote if it contains CSV special chars.
  if (/[",\n\r]/.test(safeStr))
    return `"${safeStr.replace(/"/g, '""')}"`
  return safeStr
}

/**
 * Generate a CSV document from a header and row records.
 * Always ends with a trailing newline for spreadsheet import compatibility.
 */
export function toCsv<THeader extends readonly string[]>(
  header: THeader,
  rows: Array<Record<THeader[number], unknown>>,
): string {
  const lines: string[] = []
  lines.push(header.join(','))
  for (const row of rows) {
    lines.push(header.map((key: THeader[number]) => escapeCsvValue(row[key])).join(','))
  }
  // Always end with newline so spreadsheet import is consistent.
  return `${lines.join('\n')}\n`
}

function stripControlChars(input: string): string {
  let out = ''
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0 && code <= 31) || code === 127)
      continue
    out += char
  }
  return out
}

/** Safe download filename. Strips path separators and control characters. */
export function sanitizeFilename(input: string | undefined, extension: 'csv' | 'json'): string | undefined {
  if (!input)
    return undefined

  const trimmed = input.trim()
  if (!trimmed)
    return undefined

  const safe = stripControlChars(trimmed)
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 180)

  const ext = `.${extension}`
  if (safe.toLowerCase().endsWith(ext))
    return safe
  return `${safe}${ext}`
}

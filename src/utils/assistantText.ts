import { isSafeImageFetchUrl, sanitizeHttpUrl } from './urlSafety'

export interface AssistantSpan {
  text: string
  style: 'plain' | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'image'
  href?: string
}

export type AssistantBlock
  = | { type: 'paragraph', spans: AssistantSpan[] }
    | { type: 'heading', level: number, spans: AssistantSpan[] }
    | { type: 'list', ordered: boolean, items: AssistantSpan[][] }
    | { type: 'code', language: string, text: string }
    | { type: 'quote', spans: AssistantSpan[] }
    | { type: 'table', headers: AssistantSpan[][], rows: AssistantSpan[][][] }
    | { type: 'image', alt: string, href: string }
    | { type: 'rule' }

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/
const ORDERED = /^\s*\d+[.)]\s+/
const HEADING = /^(#{1,6})\s+(\S.*)$/
const RULE = /^\s*(?:---|\*\*\*|___)\s*$/
const QUOTE = /^\s*> ?/

/**
 * Markdown for the assistant bubble.
 * Tokens are text only. Model HTML is never parsed or inserted.
 */
export function tokenizeInline(text: string, allowLinks = true): AssistantSpan[] {
  const spans: AssistantSpan[] = []
  let plainStart = 0
  let index = 0
  while (index < text.length) {
    const token = tryToken(text, index, allowLinks)
    if (!token) {
      index++
      continue
    }
    if (index > plainStart)
      pushPlain(spans, text.slice(plainStart, index))
    pushSpan(spans, token.span)
    index = token.end
    plainStart = index
  }
  if (plainStart < text.length)
    pushPlain(spans, text.slice(plainStart))
  return spans
}

function trimBareUrl(raw: string): string {
  let end = raw.length
  while (end > 0 && /[),.;:!?]/.test(raw[end - 1])) {
    if (raw[end - 1] === ')') {
      const head = raw.slice(0, end)
      const open = head.split('(').length - 1
      const close = head.split(')').length - 1
      if (close <= open)
        break
    }
    end--
  }
  return raw.slice(0, end)
}

function pushSpan(spans: AssistantSpan[], span: AssistantSpan) {
  if (!span.text && span.style === 'plain')
    return
  const prev = spans.at(-1)
  if (span.style === 'plain' && prev?.style === 'plain') {
    prev.text += span.text
    return
  }
  spans.push(span)
}

function pushPlain(spans: AssistantSpan[], text: string) {
  if (!text)
    return
  const pattern = /https:\/\/[^\s<>]+/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last)
      pushSpan(spans, { text: text.slice(last, at), style: 'plain' })
    const raw = match[0]
    const hrefText = trimBareUrl(raw)
    const href = sanitizeHttpUrl(hrefText)
    pushSpan(spans, href ? { text: hrefText, style: 'link', href } : { text: hrefText, style: 'plain' })
    if (hrefText.length < raw.length)
      pushSpan(spans, { text: raw.slice(hrefText.length), style: 'plain' })
    last = at + raw.length
  }
  if (last < text.length)
    pushSpan(spans, { text: text.slice(last), style: 'plain' })
}

function tryToken(text: string, index: number, allowLinks: boolean): { end: number, span: AssistantSpan } | null {
  const ch = text[index]
  if (ch === '\\') {
    const next = text[index + 1]
    if (next && '`*_~[!\\'.includes(next))
      return { end: index + 2, span: { text: next, style: 'plain' } }
    return null
  }
  if (ch === '`')
    return parseWrapped(text, index, '`', 'code')
  if (allowLinks && ch === '!' && text[index + 1] === '[')
    return parseLink(text, index, true)
  if (allowLinks && ch === '[')
    return parseLink(text, index, false)
  if (ch === '~')
    return parseWrapped(text, index, '~~', 'strike')
  if (ch === '*')
    return parseWrapped(text, index, '**', 'bold') ?? parseEmphasis(text, index, '*')
  if (ch === '_')
    return parseEmphasis(text, index, '_')
  return null
}

function parseWrapped(text: string, index: number, marker: string, style: 'code' | 'bold' | 'strike'): { end: number, span: AssistantSpan } | null {
  if (!text.startsWith(marker, index))
    return null
  const start = index + marker.length
  const end = text.indexOf(marker, start)
  if (end < 0)
    return null
  const body = text.slice(start, end)
  if (!body || body.includes('\n'))
    return null
  return { end: end + marker.length, span: { text: body, style } }
}

function parseEmphasis(text: string, index: number, marker: '*' | '_'): { end: number, span: AssistantSpan } | null {
  if (text[index] !== marker)
    return null
  if (marker === '_' && index > 0 && /\w/.test(text[index - 1]))
    return null
  const start = index + 1
  const next = text[start]
  if (!next || next === ' ' || next === '\n' || next === marker)
    return null
  const end = text.indexOf(marker, start)
  if (end < 0)
    return null
  const body = text.slice(start, end)
  if (!body || body.includes('\n') || body.endsWith(' '))
    return null
  if (marker === '_') {
    const after = text[end + 1]
    if (after && /\w/.test(after))
      return null
  }
  return { end: end + 1, span: { text: body, style: 'italic' } }
}

function visibleText(text: string): string {
  return tokenizeInline(text, false).map(span => span.text).join('')
}

function parseLink(text: string, index: number, image: boolean): { end: number, span: AssistantSpan } | null {
  if (image) {
    if (text[index] !== '!' || text[index + 1] !== '[')
      return null
  }
  else if (text[index] !== '[') {
    return null
  }
  const labelStart = index + (image ? 2 : 1)
  const labelEnd = text.indexOf(']', labelStart)
  if (labelEnd < 0 || text[labelEnd + 1] !== '(')
    return null
  let hrefEnd = -1
  let depth = 0
  for (let cursor = labelEnd + 2; cursor < text.length; cursor++) {
    const ch = text[cursor]
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      if (depth === 0) {
        hrefEnd = cursor
        break
      }
      depth--
    }
    else if (ch === '\n') {
      return null
    }
  }
  if (hrefEnd < 0)
    return null
  const label = text.slice(labelStart, labelEnd)
  const rawHref = text.slice(labelEnd + 2, hrefEnd).trim()
  if (label.includes('\n') || rawHref.includes('\n') || !rawHref)
    return null
  const end = hrefEnd + 1
  const shown = visibleText(label)
  if (image) {
    const href = isSafeImageFetchUrl(rawHref) ? sanitizeHttpUrl(rawHref) : null
    if (!href)
      return { end, span: { text: shown, style: 'plain' } }
    return { end, span: { text: shown, style: 'image', href } }
  }
  const href = sanitizeHttpUrl(rawHref)
  if (!href)
    return { end, span: { text: shown, style: 'plain' } }
  return { end, span: { text: shown, style: 'link', href } }
}

function splitCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|'))
    text = text.slice(1)
  if (text.endsWith('|'))
    text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (ch === '\\' && text[index + 1] === '|') {
      current += '|'
      index++
      continue
    }
    if (ch === '`')
      inCode = !inCode
    if (ch === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

function isSeparatorRow(line: string | undefined): boolean {
  if (!line?.includes('|'))
    return false
  const cells = splitCells(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function padRow(cells: string[], width: number): string[] {
  const next = cells.slice(0, width)
  while (next.length < width)
    next.push('')
  return next
}

/** ``` plus an optional language token. Null when the line is not a fence. */
function fenceLanguage(line: string): string | null {
  let index = 0
  while (line[index] === ' ' || line[index] === '\t')
    index++
  if (!line.startsWith('```', index))
    return null
  index += 3
  while (line[index] === ' ' || line[index] === '\t')
    index++
  const language = line.slice(index).trimEnd()
  if (language.includes('`') || /\s/.test(language))
    return null
  return language
}

function cellSpans(cells: string[]): AssistantSpan[][] {
  return cells.map(cell => tokenizeInline(cell))
}

/** Split a model reply into blocks the chat bubble can render. */
export function tokenizeAssistantText(text: string): AssistantBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: AssistantBlock[] = []
  let paragraph: string[] = []
  let list: AssistantSpan[][] = []
  let listOrdered = false
  let quote: string[] = []

  const flushParagraph = () => {
    if (!paragraph.length)
      return
    const spans = tokenizeInline(paragraph.join('\n'))
    if (spans.length === 1 && spans[0].style === 'image' && spans[0].href)
      blocks.push({ type: 'image', alt: spans[0].text, href: spans[0].href })
    else if (spans.length)
      blocks.push({ type: 'paragraph', spans })
    paragraph = []
  }
  const flushList = () => {
    if (!list.length)
      return
    blocks.push({ type: 'list', ordered: listOrdered, items: list })
    list = []
  }
  const flushQuote = () => {
    if (!quote.length)
      return
    const spans = tokenizeInline(quote.join('\n'))
    if (spans.length)
      blocks.push({ type: 'quote', spans })
    quote = []
  }
  const flush = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const language = fenceLanguage(line)
    if (language !== null) {
      flush()
      const body: string[] = []
      index++
      while (index < lines.length && fenceLanguage(lines[index]) !== '') {
        body.push(lines[index])
        index++
      }
      blocks.push({ type: 'code', language, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    if (line.includes('|') && isSeparatorRow(lines[index + 1])) {
      flush()
      const headers = splitCells(line)
      const width = headers.length
      index++
      const rows: AssistantSpan[][][] = []
      while (index + 1 < lines.length && lines[index + 1].trim() !== '' && lines[index + 1].includes('|') && !isSeparatorRow(lines[index + 1])) {
        index++
        rows.push(cellSpans(padRow(splitCells(lines[index]), width)))
      }
      blocks.push({ type: 'table', headers: cellSpans(headers), rows })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, spans: tokenizeInline(heading[2]) })
      continue
    }

    if (RULE.test(line)) {
      flush()
      blocks.push({ type: 'rule' })
      continue
    }

    const quoteMatch = line.match(QUOTE)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quote.push(line.slice(quoteMatch[0].length))
      continue
    }

    if (BULLET.test(line)) {
      flushParagraph()
      flushQuote()
      const ordered = ORDERED.test(line)
      if (list.length && ordered !== listOrdered)
        flushList()
      listOrdered = ordered
      list.push(tokenizeInline(line.replace(BULLET, '')))
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line)
  }
  flush()
  return blocks
}

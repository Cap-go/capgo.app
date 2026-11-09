import { sanitizeHttpUrl } from '~/utils/sanitize'

export type AdvisoryInlinePart = { kind: 'text' | 'bold' | 'code', text: string } | { kind: 'link', text: string, href: string }

export type AdvisoryMarkdownBlock = { kind: 'heading', parts: AdvisoryInlinePart[] } | { kind: 'paragraph', parts: AdvisoryInlinePart[] } | { kind: 'list', ordered: boolean, items: AdvisoryInlinePart[][] }

export function advisoryInlineParts(text: string): AdvisoryInlinePart[] {
  const parts: AdvisoryInlinePart[] = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last)
      parts.push(...advisoryPlainTextParts(text.slice(last, index)))
    if (match[1]) {
      parts.push({ kind: 'bold', text: match[1] })
    }
    else if (match[2]) {
      parts.push({ kind: 'code', text: match[2] })
    }
    last = index + match[0].length
  }
  if (last < text.length)
    parts.push(...advisoryPlainTextParts(text.slice(last)))
  return parts.length ? parts : [{ kind: 'text', text }]
}

function readMarkdownLink(text: string, open: number) {
  const labelEnd = text.indexOf(']', open + 1)
  if (labelEnd < 0 || text[labelEnd + 1] !== '(')
    return null

  let depth = 0
  for (let i = labelEnd + 2; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      if (depth === 0) {
        return {
          end: i + 1,
          label: text.slice(open + 1, labelEnd),
          href: text.slice(labelEnd + 2, i),
        }
      }
      depth--
    }
  }
  return null
}

function advisoryPlainTextParts(text: string): AdvisoryInlinePart[] {
  const parts: AdvisoryInlinePart[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('[', cursor)
    if (open < 0) {
      parts.push({ kind: 'text', text: text.slice(cursor) })
      break
    }
    if (open > cursor)
      parts.push({ kind: 'text', text: text.slice(cursor, open) })

    const link = readMarkdownLink(text, open)
    if (!link) {
      parts.push({ kind: 'text', text: text.slice(open, open + 1) })
      cursor = open + 1
      continue
    }

    const safe = sanitizeHttpUrl(link.href)
    if (safe) {
      parts.push({ kind: 'link', text: link.label, href: safe })
    }
    else {
      parts.push({ kind: 'text', text: link.label })
    }
    cursor = link.end
  }
  return parts.length ? parts : [{ kind: 'text', text }]
}

export function parseSecurityAdvisoryMarkdown(markdown: string): AdvisoryMarkdownBlock[] {
  if (!markdown.trim())
    return []

  const blocks: AdvisoryMarkdownBlock[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let listItems: AdvisoryInlinePart[][] = []
  let inOrdered = false

  function flushList() {
    if (!listItems.length)
      return
    blocks.push({ kind: 'list', ordered: inOrdered, items: listItems })
    listItems = []
    inOrdered = false
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushList()
      continue
    }

    if (line.startsWith('#')) {
      flushList()
      const headingText = line.replace(/^#+\s*/, '')
      blocks.push({ kind: 'heading', parts: advisoryInlineParts(headingText) })
      continue
    }

    const orderedMatch = line.match(/^(\d+)\.\s(.*)$/)
    if (orderedMatch) {
      if (!inOrdered && listItems.length)
        flushList()
      inOrdered = true
      listItems.push(advisoryInlineParts(orderedMatch[2]))
      continue
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (inOrdered && listItems.length)
        flushList()
      inOrdered = false
      listItems.push(advisoryInlineParts(line.slice(2)))
      continue
    }

    flushList()
    blocks.push({ kind: 'paragraph', parts: advisoryInlineParts(line) })
  }

  flushList()
  return blocks
}

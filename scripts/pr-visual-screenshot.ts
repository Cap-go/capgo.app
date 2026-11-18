import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

export const MISSING_SCREENSHOT_REVIEW = 'missing screenshot for review'

const VISUAL_PATHS = [
  /^src\/.+\.vue$/,
  /^src\/.+\.css$/,
  /^src\/.+\.(?:scss|sass|less)$/,
  /^src\/.+\.svg$/,
  /^supabase\/templates\/.+\.html$/,
  /^cloudflare_workers\/api\/email_templates\/.+\.html$/,
  /^ios\/.+\.(?:storyboard|xib)$/,
  /^android\/.+\/res\/layout\/[^/]+\.xml$/,
  /^android\/.+\/res\/drawable[^/]*\/[^/]+\.xml$/,
]

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+[^)]*)?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[A-Za-z0-9._-]+/gi
const USER_IMAGE = /https:\/\/(?:private-)?user-images\.githubusercontent\.com\/\S+/gi
const CAMO = /https:\/\/camo\.githubusercontent\.com\/\S+/gi
const MEDIA_URL = /https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)(?:[?#][^\s)]*)?/gi
const GENERATED_FOOTERS = [
  ['<!-- codesmith:footer -->', '<!-- /codesmith:footer -->'],
  ['<!-- This is an auto-generated description by cubic. -->', '<!-- End of auto-generated description by cubic. -->'],
] as const

export interface MissingScreenshotReview {
  ok: false
  message: typeof MISSING_SCREENSHOT_REVIEW
  files: string[]
}

export type VisualScreenshotReview = { ok: true } | MissingScreenshotReview

export function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.?\//, '')
}

export function isVisualPath(path: string): boolean {
  const normalized = normalizePath(path)
  return VISUAL_PATHS.some(pattern => pattern.test(normalized))
}

function stripMarkedBlock(body: string, start: string, end: string): string {
  let result = ''
  let cursor = 0
  while (cursor < body.length) {
    const open = body.indexOf(start, cursor)
    if (open === -1) {
      result += body.slice(cursor)
      break
    }
    result += body.slice(cursor, open)
    const close = body.indexOf(end, open + start.length)
    if (close === -1)
      break
    cursor = close + end.length
  }
  return result
}

function stripHtmlComments(body: string): string {
  let result = ''
  let cursor = 0
  while (cursor < body.length) {
    const start = body.indexOf('<!--', cursor)
    if (start === -1) {
      result += body.slice(cursor)
      break
    }
    result += body.slice(cursor, start)
    const end = body.indexOf('-->', start + 4)
    if (end === -1)
      break
    cursor = end + 3
  }
  return result
}

function visibleDescription(body: string): string {
  let visible = body
  for (const [start, end] of GENERATED_FOOTERS)
    visible = stripMarkedBlock(visible, start, end)
  return stripHtmlComments(visible)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
}

function isBadgeUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed)
    return true
  let parsed: URL
  try {
    parsed = new URL(trimmed, 'https://capgo.local')
  }
  catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  if (host === 'img.shields.io' || host === 'shields.io')
    return true
  if ((host === 'cubic.dev' || host === 'www.cubic.dev') && path.startsWith('/buttons/'))
    return true
  if (host === 'pr-comments-assets.blacksmith.sh')
    return true
  if (host === 'sonarsource.github.io')
    return true
  return host === 'codspeed.io' && path.startsWith('/pr-report/')
}

function hasRealImage(pattern: RegExp, text: string): boolean {
  for (const match of text.matchAll(pattern)) {
    const url = match[1] || match[2] || match[3] || match[0]
    if (!isBadgeUrl(url))
      return true
  }
  return false
}

export function descriptionHasScreenshot(body: string | null | undefined): boolean {
  const visible = visibleDescription(body ?? '')
  return hasRealImage(MARKDOWN_IMAGE, visible)
    || hasRealImage(HTML_IMAGE, visible)
    || hasRealImage(ATTACHMENT, visible)
    || hasRealImage(USER_IMAGE, visible)
    || hasRealImage(CAMO, visible)
    || hasRealImage(MEDIA_URL, visible)
}

export function reviewVisualScreenshot(
  paths: readonly string[],
  body: string | null | undefined,
): VisualScreenshotReview {
  const files: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const normalized = normalizePath(path)
    if (!normalized || seen.has(normalized) || !isVisualPath(normalized))
      continue
    seen.add(normalized)
    files.push(normalized)
  }

  if (files.length === 0 || descriptionHasScreenshot(body))
    return { ok: true }

  return {
    ok: false,
    message: MISSING_SCREENSHOT_REVIEW,
    files,
  }
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1)
    return undefined
  return process.argv[index + 1]
}

if (import.meta.main) {
  const filesPath = readFlag('--files')
  if (!filesPath) {
    console.error('Usage: bun scripts/pr-visual-screenshot.ts --files <path>')
    process.exit(2)
  }

  const files = readFileSync(filesPath, 'utf8').split('\n')
  const result = reviewVisualScreenshot(files, process.env.PR_BODY ?? '')
  const outPath = process.env.VISUAL_SCREENSHOT_RESULT
  if (outPath)
    writeFileSync(outPath, `${JSON.stringify(result)}\n`)

  if (result.ok)
    process.exit(0)

  console.error(result.message)
  for (const file of result.files)
    console.error(file)
  process.exit(1)
}

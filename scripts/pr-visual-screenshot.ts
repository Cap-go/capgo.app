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

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+[^)]*)?\s*\)/
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[A-Za-z0-9._-]+/i
const USER_IMAGE = /https:\/\/(?:private-)?user-images\.githubusercontent\.com\/\S+/i
const CAMO = /https:\/\/camo\.githubusercontent\.com\/\S+/i
const MEDIA_URL = /https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)(?:[?#][^\s)]*)?/i

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

function visibleDescription(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
}

export function descriptionHasScreenshot(body: string | null | undefined): boolean {
  const visible = visibleDescription(body ?? '')
  return MARKDOWN_IMAGE.test(visible)
    || HTML_IMAGE.test(visible)
    || ATTACHMENT.test(visible)
    || USER_IMAGE.test(visible)
    || CAMO.test(visible)
    || MEDIA_URL.test(visible)
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

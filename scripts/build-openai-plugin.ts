#!/usr/bin/env bun
/**
 * Validate and package the Capgo OpenAI plugin (integrations/openai-plugin) as a submission ZIP.
 * Limits come from https://developers.openai.com/plugins/deploy/submission.
 *
 *   bun scripts/build-openai-plugin.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../integrations/openai-plugin')
/** Everything else in the plugin folder (README, review notes) stays out of the ZIP. */
export const PACKAGE_ENTRIES = ['plugin.json', 'mcp.json', 'skills', 'assets']

const MAX_ASSET_BYTES = 5 * 1024 * 1024
const HEX_COLOR = /^#[0-9a-f]{6}$/i

type Json = Record<string, any>

function checkLength(errors: string[], field: string, value: unknown, max: number, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required)
      errors.push(`${field} is required`)
    return
  }
  if (typeof value !== 'string')
    errors.push(`${field} must be a string`)
  else if (value.length > max)
    errors.push(`${field} is ${value.length} characters, max ${max}`)
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string')
    return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0
  }
  catch {
    return false
  }
}

function checkUrl(errors: string[], field: string, value: unknown) {
  checkLength(errors, field, value, 1024)
  if (typeof value === 'string' && !isHttpsUrl(value))
    errors.push(`${field} must be an https URL`)
}

function pngSize(file: Uint8Array): { width: number, height: number } | null {
  if (file.length < 24 || new TextDecoder().decode(file.subarray(1, 4)) !== 'PNG')
    return null
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function checkAsset(errors: string[], dir: string, field: string, value: unknown, square: boolean) {
  if (typeof value !== 'string' || !value.startsWith('./')) {
    errors.push(`${field} must be a ./-prefixed path`)
    return
  }
  // Resolve first so ./assets/../README.md or hidden files cannot slip past the packaged set.
  const path = resolve(dir, value)
  const packaged = path.startsWith(resolve(dir, 'assets') + sep) && !relative(dir, path).split(sep).some(part => part.startsWith('.'))
  if (!packaged) {
    errors.push(`${field} must point to a non-hidden file under ./assets/ so it is packaged`)
    return
  }
  if (!existsSync(path)) {
    errors.push(`${field} points to missing file ${value}`)
    return
  }
  const file = readFileSync(path)
  if (file.length > MAX_ASSET_BYTES)
    errors.push(`${field} is larger than 5 MiB`)
  // OpenAI also accepts JPEG, WebP and SVG; this package sticks to PNG so sizes can be checked here.
  const size = pngSize(file)
  if (!size) {
    errors.push(`${field} must be a valid PNG file`)
    return
  }
  if (square && size.width !== size.height)
    errors.push(`${field} must be square, got ${size.width}x${size.height}`)
  if (Math.min(size.width, size.height) < 48 || Math.max(size.width, size.height) > 4096)
    errors.push(`${field} must be between 48 and 4096 pixels, got ${size.width}x${size.height}`)
}

function checkSkills(errors: string[], dir: string) {
  const skillsDir = join(dir, 'skills')
  if (!existsSync(skillsDir))
    return
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md')
    if (!existsSync(file)) {
      errors.push(`skills/${name} has no SKILL.md`)
      continue
    }
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
    const skillName = /^name:\s*(\S.*)$/m.exec(frontmatter)?.[1]?.trim()
    if (skillName !== name)
      errors.push(`skills/${name}/SKILL.md frontmatter name must be "${name}"`)
    if (!/^description:\s*\S/m.test(frontmatter))
      errors.push(`skills/${name}/SKILL.md needs a description`)
  }
}

export function validateOpenAiPlugin(dir = PLUGIN_DIR): string[] {
  const errors: string[] = []
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Json

  if (typeof manifest.name !== 'string' || manifest.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name))
    errors.push('name must be lowercase letters, numbers and single hyphens, max 64 characters')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(manifest.version))
    errors.push('version must be semver')
  checkLength(errors, 'description', manifest.description, 4000)
  checkLength(errors, 'author.name', manifest.author?.name, 120)
  if (manifest.author?.url !== undefined && !isHttpsUrl(manifest.author.url))
    errors.push('author.url must be an https URL')

  const ui = manifest.extensions?.['com.openai']?.interface as Json | undefined
  if (!ui) {
    errors.push('extensions["com.openai"].interface is required')
    return errors
  }
  checkLength(errors, 'displayName', ui.displayName, 30)
  checkLength(errors, 'shortDescription', ui.shortDescription, 30)
  checkLength(errors, 'longDescription', ui.longDescription, 4000)
  checkLength(errors, 'developerName', ui.developerName, 80)
  checkLength(errors, 'category', ui.category, 80)
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'])
    checkUrl(errors, field, ui[field])

  const capabilities = ui.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.length > 20 || capabilities.some((entry: unknown) => typeof entry !== 'string' || entry.length > 120))
    errors.push('capabilities must be at most 20 strings of 120 characters')
  const prompts = typeof ui.defaultPrompt === 'string' ? [ui.defaultPrompt] : ui.defaultPrompt ?? []
  if (!Array.isArray(prompts) || prompts.length > 3 || prompts.some((entry: unknown) => typeof entry !== 'string' || entry.length > 128 || entry.includes('@')))
    errors.push('defaultPrompt must be at most 3 prompts of 128 characters without @mentions')
  for (const field of ['brandColor', 'brandColorDark']) {
    if (ui[field] !== undefined && !HEX_COLOR.test(ui[field]))
      errors.push(`${field} must be #RRGGBB`)
  }

  checkAsset(errors, dir, 'logo', ui.logo, true)
  checkAsset(errors, dir, 'composerIcon', ui.composerIcon, true)
  for (const field of ['logoDark', 'composerIconDark']) {
    if (ui[field] !== undefined)
      checkAsset(errors, dir, field, ui[field], true)
  }
  const screenshots = ui.screenshots ?? []
  if (Array.isArray(screenshots)) {
    for (const [index, screenshot] of screenshots.entries())
      checkAsset(errors, dir, `screenshots[${index}]`, screenshot, false)
  }
  else {
    errors.push('screenshots must be an array of paths')
  }

  const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as Json
  const servers = Object.entries(mcp.mcpServers ?? {}) as Array<[string, Json]>
  if (servers.length === 0)
    errors.push('mcp.json must declare an MCP server')
  for (const [name, server] of servers) {
    if (server.type !== 'streamable-http')
      errors.push(`mcp.json ${name}: type must be streamable-http`)
    if (!isHttpsUrl(server.url))
      errors.push(`mcp.json ${name}: url must be an absolute https URL`)
  }

  checkSkills(errors, dir)
  return errors
}

function listFiles(path: string): string[] {
  if (!statSync(path).isDirectory())
    return [path]
  return readdirSync(path).filter(entry => !entry.startsWith('.')).flatMap(entry => listFiles(join(path, entry)))
}

async function main() {
  const errors = validateOpenAiPlugin()
  if (errors.length > 0) {
    console.error(`Plugin package is invalid:\n- ${errors.join('\n- ')}`)
    process.exit(1)
  }
  const { version } = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8')) as { version: string }
  const outDir = resolve(PLUGIN_DIR, '../../dist/openai-plugin')
  const outFile = join(outDir, `capgo-${version}.zip`)
  mkdirSync(outDir, { recursive: true })
  rmSync(outFile, { force: true })

  const files = PACKAGE_ENTRIES
    .filter(entry => existsSync(join(PLUGIN_DIR, entry)))
    .flatMap(entry => listFiles(join(PLUGIN_DIR, entry)))
    .map(file => relative(PLUGIN_DIR, file))
  const zip = spawnSync('zip', ['-X', '-q', outFile, ...files], { cwd: PLUGIN_DIR, stdio: 'inherit' })
  if (zip.status !== 0)
    process.exit(zip.status ?? 1)
  console.log(`${outFile}\n${files.map(file => `  ${file}`).join('\n')}`)
}

if (import.meta.main)
  await main()

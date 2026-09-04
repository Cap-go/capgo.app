#!/usr/bin/env bun
/**
 * Compute Subresource Integrity (SRI) hashes from real remote bytes.
 *
 * Usage:
 *   bun run security:compute-integrity -- <url> [<url>...]
 *   bun run security:compute-integrity -- --file scripts/external-integrity-sources.json
 *
 * Never invent integrity attributes — always regenerate from this script when a
 * pinned third-party asset changes.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

interface IntegritySource {
  url: string
  label?: string
}

function parseArgs(argv: string[]) {
  const fileFlagIndex = argv.indexOf('--file')
  if (fileFlagIndex !== -1) {
    const filePath = argv[fileFlagIndex + 1]
    if (!filePath)
      throw new Error('Missing path after --file')
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as IntegritySource[] | { sources: IntegritySource[] }
    return Array.isArray(parsed) ? parsed : parsed.sources
  }

  const urls = argv.filter(arg => arg !== '--' && !arg.startsWith('--'))
  return urls.map(url => ({ url }))
}

async function fetchBytes(url: string) {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function toIntegrity(buffer: Buffer, algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha384') {
  const digest = createHash(algorithm).update(buffer).digest('base64')
  return `${algorithm}-${digest}`
}

async function main() {
  const sources = parseArgs(process.argv.slice(2))
  if (sources.length === 0) {
    console.error('Provide at least one URL or --file <json>')
    process.exit(1)
  }

  for (const source of sources) {
    const bytes = await fetchBytes(source.url)
    const integrity = toIntegrity(bytes)
    const label = source.label ? `${source.label}: ` : ''
    console.log(`${label}${source.url}`)
    console.log(`  integrity="${integrity}"`)
    console.log(`  crossorigin="anonymous"`)
    console.log(`  bytes=${bytes.length}`)
    console.log('')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

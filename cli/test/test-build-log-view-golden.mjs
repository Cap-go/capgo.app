#!/usr/bin/env bun
// Renders FullscreenBuildOutput with the canonical build-fails-with-ai transcript
// and prints the normalized grid for golden diffing (no macOS PTY required).
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from 'ink'
import React from 'react'
import { FullscreenBuildOutput } from '../src/build/onboarding/ui/components.tsx'
import { frameToGrid } from './helpers/vt-grid.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUITE = join(HERE, '../../private/cli-mcp-tests/e2e-tui')
const { normalizeGrid } = await import(join(SUITE, 'harness/normalize.mjs'))

const BUILD_LOG_LINES = [
  '⚙️  Provisioning macOS build runner (macos-14, Xcode 16.2)…',
  '📦  Cloning project sources…',
  '📦  Installing CocoaPods dependencies…',
  '🔧  Resolving Swift package dependencies…',
  '🍎  xcodebuild archive -scheme App -configuration Release',
  '    Compiling AppDelegate.swift',
  '    Compiling App.swift',
  '    Linking E2E Demo',
  '🔏  Signing with the Apple Distribution profile…',
  '📝  Exporting signed .ipa…',
  '☁️  Uploading build artifact to Capgo…',
  '✅  Build succeeded in 1m 42s',
]

const TIP = 'Tip: if this looks cache-related (stale artifacts between RC/PROD or branches), retry with --cache-key <env> to isolate compilation cache, or --no-cache to skip cache restore.'

function buildOutputLines(platform) {
  const lines = []
  lines.push(`Requesting build for com.capgo.e2e.demo (${platform})...`)
  lines.push('Requesting native build for com.capgo.e2e.demo')
  lines.push(`Platform: ${platform}`)
  lines.push('Project: /var/folders/xx/project')
  // request.ts logs the security block as one leading-\n line plus two indented
  // lines and a trailing-\n on the last — not as separate empty array entries.
  lines.push('\n🔒 Security: Credentials are never stored on Capgo servers')
  lines.push('   They are used only during build and deleted after')
  lines.push('   Build outputs can optionally be uploaded for time-limited download links\n')
  lines.push('ℹ️  --build-mode not specified, defaulting to release')
  lines.push('ℹ️  --output-upload not specified, defaulting to false (no Capgo download link)')
  lines.push('ℹ️  --output-retention not specified, defaulting to 3600s (1 hour)')
  lines.push('ℹ️  --skip-build-number-bump not specified, build number will be auto-incremented (default)')
  if (platform === 'ios')
    lines.push('ℹ️  --skip-marketing-version-bump not specified, marketing version will be auto-bumped when already released (default)')
  lines.push('✓ Using credentials (merged from CLI args, env vars, and saved file)')
  lines.push('Requesting build from Capgo...')
  lines.push('✔ Build job created: e2e-job-1')
  lines.push('Status: created')
  lines.push(`Zipping ${platform} project from /var/folders/xx/project...`)
  lines.push('✔ Created zip: /var/folders/xx/project.zip (0.00 MB)')
  lines.push('Uploading to builder...')
  lines.push('Uploading: 100%')
  lines.push('Starting build job...')
  lines.push('✔ Build started!')
  lines.push('Streaming build logs...')
  lines.push('Connecting to log streaming...')
  lines.push('')
  for (const line of BUILD_LOG_LINES)
    lines.push(line)
  lines.push('❌  Build failed: module \'Capacitor\' not found (1 error)')
  lines.push('✖ Build failed')
  lines.push(TIP)
  lines.push('⚠ unknown error')
  return lines
}

function makeStdout(cols, rows) {
  const s = new EventEmitter()
  s.columns = cols
  s.rows = rows
  s.isTTY = true
  s.lastFrame = ''
  s.write = (f) => {
    s.lastFrame = f
    return true
  }
  return s
}

function makeStdin() {
  const s = new EventEmitter()
  s.isTTY = true
  s.setEncoding = () => {}
  s.setRawMode = () => {}
  s.resume = () => {}
  s.pause = () => {}
  s.ref = () => {}
  s.unref = () => {}
  s.read = () => null
  return s
}

async function renderGrid(platform, rows) {
  const cols = 80
  const lines = buildOutputLines(platform)
  const stdout = makeStdout(cols, rows)
  const inst = render(
    React.createElement(FullscreenBuildOutput, {
      title: 'Build failed',
      lines,
      terminalRows: rows,
      onExit: () => {},
    }),
    { stdout, stderr: makeStdout(cols, rows), stdin: makeStdin(), debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 80))
  const frame = (stdout.lastFrame ?? '').replace(/\n$/, '')
  inst.unmount()
  const grid = await frameToGrid(frame, { cols, rows })
  const text = grid.join('\n')
  const normalized = normalizeGrid(text, {
    tmpPrefixes: [
      { prefix: '/var/folders/xx/project', token: '<project>' },
      { prefix: '/var/folders/xx/project.zip', token: '<zip>' },
    ],
  })
  return { lines, normalized }
}

let failed = 0
for (const [platform, rows, world] of [['ios', 44, 'build-fails-with-ai'], ['android', 49, 'android-build-fails-with-ai']]) {
  const { lines, normalized } = await renderGrid(platform, rows)
  const goldenPath = join(SUITE, `goldens/${world}/build-log-view.txt`)
  const golden = readFileSync(goldenPath, 'utf8')
  console.log(`\n=== ${platform} lines=${lines.length} rows=${rows} ===`)
  if (golden === normalized) {
    console.log('MATCH')
  }
  else {
    failed++
    console.log('MISMATCH')
    writeFileSync(`/tmp/${platform}-ink-grid.txt`, normalized)
    const g = golden.split('\n')
    const n = normalized.split('\n')
    for (let i = 0; i < Math.max(g.length, n.length); i++) {
      if (g[i] !== n[i]) {
        console.log(`  line ${i + 1}:`)
        console.log(`    - ${g[i] ?? '(missing)'}`)
        console.log(`    + ${n[i] ?? '(missing)'}`)
      }
    }
  }
}

process.exit(failed > 0 ? 1 : 0)

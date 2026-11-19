#!/usr/bin/env node
/**
 * MCP cloud-build spawn command resolution (Windows-safe node entry, not npx.cmd).
 */
import process from 'node:process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  resolveCapgoBuildSpawnCommand,
  resolveCurrentCliEntry,
  resolveCurrentCliEntryFromModulePath,
  formatSpawnCommand,
  buildJobDeps,
} = await import('../src/build/onboarding/mcp/build-tools.ts')

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    console.log(`\n🔍 ${name}`)
    fn()
    console.log(`✅ PASSED: ${name}`)
    pass++
  }
  catch (e) {
    console.error(`❌ FAILED: ${name}`)
    console.error(`   ${e.message}`)
    fail++
  }
}
function eq(a, b, msg) {
  if (a !== b)
    throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
function ok(c, msg) {
  if (!c)
    throw new Error(msg || 'expected truthy')
}

const cwd = mkdtempSync(join(tmpdir(), 'capgo-mcp-spawn-'))

test('resolveCurrentCliEntry returns the package bin entry', () => {
  const entry = resolveCurrentCliEntry(cwd)
  ok(entry.includes('index.js') || entry.endsWith('dist/index.js'), `unexpected entry: ${entry}`)
})

test('resolveCurrentCliEntryFromModulePath uses bundled dist/index.js when inlined', () => {
  const bundled = join(cwd, 'node_modules', '@capgo', 'cli', 'dist', 'index.js')
  const entry = resolveCurrentCliEntryFromModulePath(bundled, cwd)
  eq(entry, bundled)
})

test('resolveCapgoBuildSpawnCommand uses node execPath, not npx', () => {
  const record = join(cwd, 'build-record.json')
  const { command, args } = resolveCapgoBuildSpawnCommand(cwd, 'com.acme.app', 'android', record)
  eq(command, process.execPath)
  ok(!args.includes('npx') && !args.includes('@capgo/cli@latest'))
  ok(args[0].endsWith('index.js') || args[0].includes('dist'))
  eq(args[1], 'build')
  eq(args[2], 'request')
  eq(args[3], 'com.acme.app')
})

test('formatSpawnCommand quotes arguments that contain spaces', () => {
  const line = formatSpawnCommand(process.execPath, ['C:\\Program Files\\capgo\\index.js', 'build', 'request'])
  eq(line, `${process.execPath} "C:\\\\Program Files\\\\capgo\\\\index.js" build request`)
})

test('spawnBuild writes the start line and resolve error when entry resolution fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-mcp-spawn-fail-'))
  const logPath = join(dir, 'build.log')
  const recordPath = join(dir, 'record.json')
  let failure
  const deps = buildJobDeps(() => cwd, {
    resolveSpawnCommand: () => {
      throw new Error('Could not resolve the running Capgo CLI entry script')
    },
  })
  const child = deps.spawnBuild({
    appId: 'com.acme.app',
    platform: 'android',
    recordPath,
    logPath,
    onProcessFailure: (message) => { failure = message },
  })
  eq(child.pid, -1)
  const log = readFileSync(logPath, 'utf8')
  ok(/Starting cloud build:/.test(log))
  ok(/Failed to resolve CLI entry:/.test(log))
  eq(failure, '[capgo] Failed to resolve CLI entry: Could not resolve the running Capgo CLI entry script')
  rmSync(dir, { recursive: true, force: true })
})

test('resolveCapgoBuildSpawnCommand on win32 still uses execPath', () => {
  const record = join(cwd, 'build-record-win.json')
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const { command, args } = resolveCapgoBuildSpawnCommand(cwd, 'com.example.app', 'ios', record)
    eq(command, process.execPath)
    ok(args[0].length > 0)
    ok(!args.includes('npx'))
  }
  finally {
    Object.defineProperty(process, 'platform', { value: original })
  }
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)

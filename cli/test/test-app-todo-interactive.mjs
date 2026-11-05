#!/usr/bin/env node
// Exercise the actual bundled command through Node streams that expose terminal
// capabilities, including the Clack-to-Ink input handoff and idle process lifetime.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { appId } from './fixtures/dual-todo.mjs'

const cwd = mkdtempSync(join(tmpdir(), 'capgo-todo-tty-'))
writeFileSync(join(cwd, 'capacitor.config.json'), JSON.stringify({ appId, appName: 'Todo TTY test', webDir: 'dist' }))
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'todo-tty-test', version: '1.0.0' }))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const environment = { ...process.env, CI: 'false', FORCE_COLOR: '1', CAPGO_TODO_FIXTURE_TTY: '1', CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1' }
delete environment.NO_COLOR

async function open(args = []) {
  const child = spawn(process.execPath, [
    '--import', fileURLToPath(new URL('./fixtures/todo-api-preload.mjs', import.meta.url)),
    fileURLToPath(new URL('../dist/index.js', import.meta.url)),
    'app', 'todo', appId, '--apikey', 'example-todo-key',
    '--api-host', 'https://todo.fixture.invalid', ...args,
  ], { cwd, env: environment })
  let output = ''
  let result
  child.stdout.on('data', data => output += data.toString())
  child.stderr.on('data', data => output += data.toString())
  const exited = new Promise(resolve => child.on('close', (exitCode, signal) => { result = { exitCode, signal }; resolve(result) }))
  const until = async (predicate, description) => {
    const deadline = Date.now() + 15_000
    while (!predicate() && !result && Date.now() < deadline)
      await pause(25)
    assert.ok(predicate(), `${description}:\n${stripVTControlCharacters(output).slice(-3000)}`)
  }
  return { child, exited, until, raw: () => output, text: () => stripVTControlCharacters(output), result: () => result }
}

let session
try {
  session = await open()
  await session.until(() => session.text().includes('App todo lists'), 'tabs must open in a real terminal')
  await pause(700)
  assert.equal(session.result(), undefined, 'the view must stay open after Clack loading prompts until a user closes it')
  session.child.stdin.write('\t')
  await session.until(() => session.text().includes('Builder checklist'), 'Tab switches to Builder')
  session.child.stdin.write('\u001B[6~')
  await session.until(() => session.text().includes('Warning: Cloud build failed'), 'the lower Builder tasks are reachable')
  session.child.stdin.write('q')
  await session.until(() => session.result(), 'q exits without hanging')
  assert.equal((await session.exited).exitCode, 0)
  assert.ok(session.raw().includes('\u001B[?1049h'), 'interactive view uses the alternate screen')
  const restored = session.raw().split('\u001B[?1049l').at(-1)
  assert.match(stripVTControlCharacters(restored), /Builder checklist/, 'the last viewed list remains in normal terminal scrollback')

  session = await open(['--list', 'builder'])
  await session.until(() => session.result(), 'an explicit selector exits even with TTY input and output')
  assert.equal((await session.exited).exitCode, 0)
  assert.match(session.text(), /Builder checklist/)
  assert.ok(!session.raw().includes('\u001B[?1049h'), 'explicit selectors never enter the tab interface')
}
finally {
  if (session && !session.result())
    session.child.kill()
  rmSync(cwd, { recursive: true, force: true })
}
console.log('Built interactive todo: remains open after loading, switches lists, scrolls, restores scrollback and honors explicit selectors passed')

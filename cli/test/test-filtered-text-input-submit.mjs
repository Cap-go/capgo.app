#!/usr/bin/env bun
// PTY regression: FilteredTextInput must submit the full buffer when characters
// and Return arrive in one burst before React re-renders (paste path + Enter).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import React from 'react'
import { FilteredTextInput } from '../src/build/onboarding/ui/components.tsx'

function makeStdout() {
  const s = new EventEmitter()
  s.columns = 80
  s.rows = 24
  s.isTTY = true
  s.write = () => true
  return s
}

function makeStdin() {
  const queue = []
  const s = new EventEmitter()
  s.isTTY = true
  s.setEncoding = () => {}
  s.setRawMode = () => {}
  s.resume = () => {}
  s.pause = () => {}
  s.ref = () => {}
  s.unref = () => {}
  s.read = () => queue.shift() ?? null
  s.push = (chunk) => {
    queue.push(chunk)
    s.emit('readable')
  }
  return s
}

function emitBurst(stdin, text) {
  for (const ch of text)
    stdin.push(ch)
  stdin.push('\r')
}

async function waitForSubmit(getSubmitted, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (getSubmitted() === null && Date.now() < deadline)
    await new Promise(r => setTimeout(r, 5))
}

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`✔ ${name}`)
  }
  else {
    failed++
    console.error(`✖ ${name}`)
  }
}

{
  let submitted = null
  const stdin = makeStdin()
  const instance = render(
    React.createElement(FilteredTextInput, {
      placeholder: 'path',
      onSubmit: (value) => {
        submitted = value
      },
    }),
    {
      stdout: makeStdout(),
      stderr: makeStdout(),
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )

  await new Promise(r => setTimeout(r, 20))
  emitBurst(stdin, '/tmp/AuthKey_ABC.p8')
  await waitForSubmit(() => submitted)
  instance.unmount()

  check('submits full pasted path when Return follows immediately', submitted === '/tmp/AuthKey_ABC.p8')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

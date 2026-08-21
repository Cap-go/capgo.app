#!/usr/bin/env bun
// Integration guard: the SHELL must actually wrap its content in MinSizeGate.
//
// The component existing isn't enough — a "wire the gate" commit was once lost
// in a stash conflict, leaving the shell rendering the wizard directly so a
// shrunk terminal clipped onboarding instead of showing the resize prompt. This
// test renders the REAL OnboardingShell (picker path — no platform, no network)
// at a sub-floor size and asserts it shows the resize prompt, not the picker;
// and at an ample size shows the picker. Drives the real useTerminalSize via a
// stdout stub whose rows/cols we control (the frame-fit harness hardcodes
// rows=200, so it can't exercise the height gate — hence a local stub here).
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { render } from 'ink'
import React from 'react'
import stringWidth from 'string-width'
import OnboardingShell from '../src/build/onboarding/ui/shell.tsx'

const watchdog = setTimeout(() => {
  console.error('WATCHDOG 30s')
  process.exit(2)
}, 30000)
watchdog.unref()

function makeStdout(cols, rows) {
  const s = new EventEmitter()
  s.columns = cols
  s.rows = rows
  s.isTTY = true
  s.frames = []
  s.lastFrame = ''
  s.write = (f) => {
    s.frames.push(f)
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

async function renderShellAt(cols, rows) {
  const stdout = makeStdout(cols, rows)
  const instance = render(
    React.createElement(OnboardingShell, { appId: 'com.test.app', iosDir: 'ios', androidDir: 'android', journeyId: 'bj_test' }),
    { stdout, stderr: makeStdout(cols, rows), stdin: makeStdin(), debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 80))
  const out = stdout.lastFrame ?? ''
  instance.unmount()
  return out
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

// The picker is gated only to the tiny banner-fits floor (44×11), NOT the full
// 80×49 onboarding floor. Three bands:
//   • below the banner floor → resize prompt (banner can't render, picker broken)
//   • banner floor .. step floor (the middle band) → picker shows (pick first)
//   • ample → picker shows
// This keeps "choose platform first" working while still informing the user when
// the terminal is too small to render the banner at all.

// Below the banner floor (44×11): resize prompt, no picker.
{
  const out = await renderShellAt(30, 8)
  check('below the banner floor shows the resize prompt', /too small/i.test(out))
  check('below the banner floor hides the picker', !/want to set up/i.test(out))
  // The prompt must name the PICKER floor (11 rows), not the step floor (49) —
  // saying "at least 49 rows" on the platform-picker screen is nonsense. Collapse
  // whitespace first so a line wrap at narrow width can't split "11 rows".
  const flat = out.replace(/\s+/g, ' ')
  check('picker prompt names the picker row floor (11), not the step floor (49)', /at least 11 rows/.test(flat) && !/\b49\b/.test(flat))
}

// Middle band (above banner floor, below the 80×49 step floor): picker shows.
{
  const out = await renderShellAt(60, 20)
  check('middle-band terminal shows the picker (choose first)', /want to set up|iOS|Android/i.test(out))
  check('no resize prompt in the middle band', !/too small/i.test(out))
}

// Ample: picker shows.
{
  const out = await renderShellAt(100, 50)
  check('picker shows on an ample terminal', /want to set up|iOS|Android/i.test(out))
  check('no resize prompt on the ample picker path', !/too small/i.test(out))
  const headerRows = out.split('\n').filter(line => /[╔║╚].*[╗║╝]/u.test(line)).slice(0, 5)
  const headerWidths = headerRows.map(stringWidth)
  check('boxed header stays rectangular', headerRows.length === 5 && new Set(headerWidths).size === 1)
  check('boxed header restores the rocket branding', headerRows.some(line => /🚀/u.test(line)))
}

console.log(`\n${passed} passed, ${failed} failed`)
clearTimeout(watchdog)
process.exit(failed > 0 ? 1 : 0)

#!/usr/bin/env node
// Regression tests for FullscreenBuildOutput — the streaming build-output viewer.
//
// The bug: the `requesting-build` step rendered its unbounded, growing output
// inside the wizard's measured body, so a long build log inflated bodyHeight and
// tripped the "terminal too small" gate — replacing a live build with a resize
// prompt on a perfectly usable terminal (the user hit it at 33 rows). The fix
// mirrors the AI viewer: a fullscreen takeover that auto-tails inside a viewport
// which ALWAYS fits the live terminal.
//
// These assert exactly that contract: no matter how long the log, the frame
// never exceeds the terminal height (so it can never report "too small"), the
// newest line is always shown (tail), and the status bar shows the line count.
import React from 'react'
import { buildScrollAction, formatElapsed, FullscreenBuildOutput } from '../src/build/onboarding/ui/components.tsx'
import { renderFrameText } from './helpers/frame-fit.mjs'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`✔ ${name}`) }
  catch (error) { failed++; console.error(`✖ ${name}\n  ${error.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
const h = React.createElement

// A long build log — the scenario that tripped "too small".
const longLog = Array.from({ length: 400 }, (_, i) => `build log line ${i + 1}`)

// Render the viewer as the terminal's full screen at a given height.
function render(lines, rows, cols = 80) {
  return renderFrameText(h(FullscreenBuildOutput, { title: 'Building...', lines, terminalRows: rows }), cols, rows)
}

function renderReadOnly(lines, rows, cols = 80) {
  return renderFrameText(h(FullscreenBuildOutput, {
    title: 'Build failed',
    lines,
    terminalRows: rows,
    onExit: () => {},
  }), cols, rows)
}

// 1. NEVER exceeds the terminal height — for any height, even with 400 lines.
//    This is the whole point: the build phase can no longer report "too small".
for (const rows of [10, 16, 24, 33, 40, 60]) {
  test(`400-line build log fits a ${rows}-row terminal (never "too small")`, () => {
    const height = render(longLog, rows).split('\n').length
    assert(height <= rows, `frame is ${height} rows, exceeds the ${rows}-row terminal`)
  })
}

// 2. Auto-tails: the newest line is always visible; far-earlier lines are gone.
test('auto-tails: newest line shown, far-earlier lines clipped', () => {
  const frame = render(longLog, 24)
  assert(frame.includes('build log line 400'), 'newest line must be visible (tail)')
  // line 10 (and 100-109, which share the substring) are all far above the
  // ~22-line viewport, so none appear.
  assert(!frame.includes('build log line 10'), 'far-earlier lines should be clipped, not shown')
})

// 3. Status bar shows the spinner label + the running line count + a timer.
test('status bar shows "Building...", the line count, and a live elapsed timer', () => {
  const frame = render(longLog, 24)
  assert(/Building/.test(frame), 'missing "Building" status')
  assert(/\(400 lines\)/.test(frame), 'missing/incorrect line count in status')
  // At mount the timer reads ~0s; only the timer matches "<digits>s" (the line
  // count is "400 lines", no digit+s).
  assert(/\b\d+s\b/.test(frame), 'missing elapsed-time clock in status')
})

// 4. A short log also fits and keeps the status bar.
test('short log fits and still shows content + status bar', () => {
  const frame = render(['✔ Build job created', 'Uploading: 100%'], 24)
  const height = frame.split('\n').length
  assert(height <= 24, `short-log frame is ${height} rows, exceeds 24`)
  assert(frame.includes('✔ Build job created'), 'short-log content should show')
  assert(/\(2 lines\)/.test(frame), 'line count should be 2')
})

// Default state is following: the status shows the "scroll back" hint, never
// "paused". (The streaming-transient flicker — where a lagging scrollOffset
// briefly read as scrolled-up — can't be reproduced in this synchronous harness,
// same as the resize bounce; deriving the hint from `follow` fixes it by
// construction. This guards against re-deriving it from a scrollOffset compare.)
test('default render follows — shows the following hint, never "paused"', () => {
  const frame = render(longLog, 24)
  assert(/scroll back/.test(frame), 'should show the following hint by default')
  assert(!/paused/.test(frame), 'must never show the paused hint while following')
})

test('read-only failed-build viewer opens at the bottom and shows how to return', () => {
  const frame = renderReadOnly(longLog, 24)
  const height = frame.split('\n').length
  assert(height <= 24, `read-only frame is ${height} rows, exceeds 24`)
  assert(frame.includes('build log line 400'), 'newest retained line must be visible at the bottom')
  assert(!frame.includes('build log line 10'), 'far-earlier lines should be clipped on initial render')
  assert(frame.includes('Build failed'), 'missing completed failure label')
  assert(frame.includes('Press Esc or Enter to go back.'), 'missing read-only dismissal hint')
})

// ── buildScrollAction: scroll/follow transitions (less +F style) ─────────────
// Pure logic, so we test it directly rather than simulating keypresses through
// the harness (which can't reliably surface input timing). maxScrollOffset=20,
// viewportRows=10 throughout.
const S = (scrollOffset, maxScrollOffset = 20, viewportRows = 10) => ({ scrollOffset, maxScrollOffset, viewportRows })

test('scroll: ↑ from the bottom pauses follow and moves up one line', () => {
  const r = buildScrollAction('', { upArrow: true }, S(20))
  assert(r && r.scrollOffset === 19 && r.follow === false, `got ${JSON.stringify(r)}`)
})

test('scroll: ↓ back to the bottom resumes follow', () => {
  const r = buildScrollAction('', { downArrow: true }, S(19))
  assert(r && r.scrollOffset === 20 && r.follow === true, `got ${JSON.stringify(r)}`)
})

test('scroll: ↓ while still above the bottom stays paused', () => {
  const r = buildScrollAction('', { downArrow: true }, S(10))
  assert(r && r.scrollOffset === 11 && r.follow === false, `got ${JSON.stringify(r)}`)
})

test('scroll: G follows from the bottom; g jumps to the top (paused)', () => {
  const g = buildScrollAction('G', {}, S(0))
  assert(g && g.scrollOffset === 20 && g.follow === true, `G: ${JSON.stringify(g)}`)
  const top = buildScrollAction('g', {}, S(20))
  assert(top && top.scrollOffset === 0 && top.follow === false, `g: ${JSON.stringify(top)}`)
})

test('scroll: PgUp/PgDn move a viewport and clamp at the edges', () => {
  const up = buildScrollAction('', { pageUp: true }, S(5))
  assert(up && up.scrollOffset === 0 && up.follow === false, `PgUp clamps to 0: ${JSON.stringify(up)}`)
  const down = buildScrollAction('', { pageDown: true }, S(15))
  assert(down && down.scrollOffset === 20 && down.follow === true, `PgDn clamps to bottom + follows: ${JSON.stringify(down)}`)
})

test('scroll: ↑ at the top stays at 0 (paused)', () => {
  const r = buildScrollAction('', { upArrow: true }, S(0))
  assert(r && r.scrollOffset === 0 && r.follow === false, `got ${JSON.stringify(r)}`)
})

test('scroll: j/k/space aliases work (vim + space-page)', () => {
  assert(buildScrollAction('k', {}, S(20)).scrollOffset === 19, 'k = up')
  assert(buildScrollAction('j', {}, S(10)).scrollOffset === 11, 'j = down')
  assert(buildScrollAction(' ', {}, S(0)).scrollOffset === 10, 'space = page down')
})

test('scroll: unhandled keys are a no-op (null)', () => {
  assert(buildScrollAction('x', {}, S(10)) === null, 'random key should be a no-op')
  assert(buildScrollAction('', { return: true }, S(10)) === null, 'enter is not a scroll key')
})

// ── formatElapsed (build timer label) ────────────────────────────────────────
test('formatElapsed: seconds under a minute, m + padded-seconds above, clamps <0', () => {
  assert(formatElapsed(0) === '0s', `0 → ${formatElapsed(0)}`)
  assert(formatElapsed(999) === '0s', `999ms → ${formatElapsed(999)}`)
  assert(formatElapsed(1000) === '1s', `1000ms → ${formatElapsed(1000)}`)
  assert(formatElapsed(59_000) === '59s', `59s → ${formatElapsed(59_000)}`)
  assert(formatElapsed(60_000) === '1m 00s', `60s → ${formatElapsed(60_000)}`)
  assert(formatElapsed(83_000) === '1m 23s', `83s → ${formatElapsed(83_000)}`)
  assert(formatElapsed(3_599_000) === '59m 59s', `3599s → ${formatElapsed(3_599_000)}`)
  assert(formatElapsed(-500) === '0s', `negative clamps → ${formatElapsed(-500)}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

#!/usr/bin/env node
// Tests for the platform picker's pure decision logic: the responsive
// cards-vs-list layout choice and the arrow/Enter keypress mapping.
import {
  PLATFORM_CARDS_MIN_COLS,
  PLATFORM_CARDS_MIN_ROWS,
  pickPlatformLayout,
} from '../src/build/onboarding/ui/frame-fit.ts'
import { cardKeyAction, platformKeyAction } from '../src/build/onboarding/ui/platform-picker.tsx'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`✔ ${name}`) }
  catch (error) { failed++; console.error(`✖ ${name}\n  ${error.message}`) }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// ── pickPlatformLayout ───────────────────────────────────────────────────────
test('cards when wide AND tall', () => {
  eq(pickPlatformLayout(80, 24), 'cards')
  eq(pickPlatformLayout(120, 40), 'cards')
})
test('exactly at the thresholds → cards', () => {
  eq(pickPlatformLayout(PLATFORM_CARDS_MIN_COLS, PLATFORM_CARDS_MIN_ROWS), 'cards')
})
test('one below width → list', () => {
  eq(pickPlatformLayout(PLATFORM_CARDS_MIN_COLS - 1, 40), 'list')
})
test('one below height → list (e.g. a short split pane)', () => {
  eq(pickPlatformLayout(120, PLATFORM_CARDS_MIN_ROWS - 1), 'list')
})
test('narrow terminal → list', () => {
  eq(pickPlatformLayout(40, 50), 'list')
})
test('tiny terminal → list', () => {
  eq(pickPlatformLayout(20, 8), 'list')
})

// ── platformKeyAction (arrows MOVE across the iOS + Android cards) ────────────
test('left / h → move -1', () => {
  eq(platformKeyAction('', { leftArrow: true }), { type: 'move', delta: -1 })
  eq(platformKeyAction('h', {}), { type: 'move', delta: -1 })
})
test('right / l → move +1', () => {
  eq(platformKeyAction('', { rightArrow: true }), { type: 'move', delta: 1 })
  eq(platformKeyAction('l', {}), { type: 'move', delta: 1 })
})
test('number keys jump to a specific card', () => {
  eq(platformKeyAction('1', {}), { type: 'jump', platform: 'ios' })
  eq(platformKeyAction('2', {}), { type: 'jump', platform: 'android' })
})
test('3 / a (former Appflow jumps) are no longer recognized → null', () => {
  eq(platformKeyAction('3', {}), null)
  eq(platformKeyAction('a', {}), null)
})
test('Enter → confirm (wins over arrows)', () => {
  eq(platformKeyAction('', { return: true }), { type: 'confirm' })
  eq(platformKeyAction('', { return: true, leftArrow: true }), { type: 'confirm' })
})
test('unrelated key → null', () => {
  eq(platformKeyAction('x', {}), null)
  eq(platformKeyAction('', {}), null)
})

// ── cardKeyAction (generic CardChooser) ──────────────────────────────────────
test('left / h → move -1', () => {
  eq(cardKeyAction('', { leftArrow: true }, 2), { type: 'move', delta: -1 })
  eq(cardKeyAction('h', {}, 2), { type: 'move', delta: -1 })
})
test('right / l → move +1', () => {
  eq(cardKeyAction('', { rightArrow: true }, 2), { type: 'move', delta: 1 })
  eq(cardKeyAction('l', {}, 2), { type: 'move', delta: 1 })
})
test('number in range → jump to that card', () => {
  eq(cardKeyAction('1', {}, 2), { type: 'jump', index: 0 })
  eq(cardKeyAction('2', {}, 2), { type: 'jump', index: 1 })
})
test('number out of range → null', () => {
  eq(cardKeyAction('3', {}, 2), null)
  eq(cardKeyAction('0', {}, 2), null)
})
test('Enter → confirm (wins over arrows)', () => {
  eq(cardKeyAction('', { return: true }, 2), { type: 'confirm' })
  eq(cardKeyAction('', { return: true, rightArrow: true }, 2), { type: 'confirm' })
})
test('unrelated key → null', () => {
  eq(cardKeyAction('x', {}, 2), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

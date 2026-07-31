import type { FC, ReactNode } from 'react'
import type { Platform } from '../types.js'
import type { PlatformPickerLayout } from './frame-fit.js'
// src/build/onboarding/ui/platform-picker.tsx
//
// The "Which platform do you want to set up?" picker, rendered INSIDE the
// alt-screen wizard (by OnboardingShell). Responsive:
//   • `cards` — bordered cards side-by-side; ←/→ (or h/l) MOVE the selection
//     across the cards (iOS ↔ Android), 1/2 jump, Enter confirms. Used when the
//     terminal has room.
//   • `list` — the same @inkjs/ui Select used everywhere else; used on narrow
//     or short terminals. The layout is chosen by the shell via
//     `pickPlatformLayout` so this component stays pure (props in → JSX out).
//
// Both layouts accept an optional `footer` rendered DIRECTLY below the legend
// (inside the same flex column), so a caller-supplied note — e.g. the analytics
// opt-out line — sits flush under "← → choose · Enter confirm" instead of
// floating mid-screen with a gap (which happens if it is a sibling competing
// with the picker's own bottom-pinning flexGrow spacer).
//
// `CardChooser` generalizes the cards-vs-list pattern (heading + bordered cards
// driven by ←/→/Enter, or a Select fallback) so other yes/no-style questions —
// e.g. the single-platform "Are you migrating from Appflow?" gate — reuse the
// SAME nice boxes instead of a bare Select.
import { Select } from '@inkjs/ui'
import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'

// The card order (left → right) for the cards layout; arrow movement walks it.
const PLATFORM_ORDER: Platform[] = ['ios', 'android']

// Pure mapping from a keypress to a picker action (extracted so the
// arrow/Enter logic is unit-testable without rendering). ←/h MOVE left, →/l
// MOVE right (so arrows can reach every card), 1/2 jump to a specific card,
// Enter confirms the current selection.
export type PlatformKeyAction
  = | { type: 'move', delta: number }
    | { type: 'jump', platform: Platform }
    | { type: 'confirm' }
    | null

export function platformKeyAction(
  input: string,
  key: { leftArrow?: boolean, rightArrow?: boolean, return?: boolean },
): PlatformKeyAction {
  if (key.return)
    return { type: 'confirm' }
  if (key.leftArrow || input === 'h')
    return { type: 'move', delta: -1 }
  if (key.rightArrow || input === 'l')
    return { type: 'move', delta: 1 }
  if (input === '1')
    return { type: 'jump', platform: 'ios' }
  if (input === '2')
    return { type: 'jump', platform: 'android' }
  return null
}

interface PlatformCardProps {
  emoji: string
  name: string
  hint: string
  selected: boolean
}

export const PlatformCard: FC<PlatformCardProps> = ({ emoji, name, hint, selected }) => (
  <Box
    flexDirection="column"
    borderStyle={selected ? 'double' : 'round'}
    borderColor={selected ? 'cyan' : 'gray'}
    paddingX={2}
  >
    <Text bold={selected} color={selected ? 'cyan' : undefined}>{`${emoji}  ${name}`}</Text>
    <Text dimColor>{hint}</Text>
  </Box>
)

export interface PlatformPickerProps {
  layout: PlatformPickerLayout
  onSelect: (platform: Platform) => void
  /** Rendered directly below the legend (flush, no gap). */
  footer?: ReactNode
}

export const PlatformPicker: FC<PlatformPickerProps> = ({ layout, onSelect, footer }) => {
  const [index, setIndex] = useState(0)
  const clamp = (i: number): number => Math.max(0, Math.min(PLATFORM_ORDER.length - 1, i))

  // Arrow/Enter driving for the cards layout. In list layout the @inkjs/ui
  // Select owns input, so this handler no-ops (it stays registered to satisfy
  // the rules of hooks, but ignores keys).
  useInput((input, key) => {
    if (layout !== 'cards')
      return
    const action = platformKeyAction(input, key)
    if (!action)
      return
    if (action.type === 'confirm')
      onSelect(PLATFORM_ORDER[index])
    else if (action.type === 'jump')
      setIndex(clamp(PLATFORM_ORDER.indexOf(action.platform)))
    else
      setIndex(i => clamp(i + action.delta))
  })

  const selected = PLATFORM_ORDER[index]

  if (layout === 'list') {
    return (
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text bold>Which platform do you want to set up?</Text>
        <Select
          options={[
            { label: '🍎  iOS', value: 'ios' },
            { label: '🤖  Android', value: 'android' },
          ]}
          onChange={value => onSelect(value as Platform)}
        />
        <Box flexGrow={1} />
        {footer}
      </Box>
    )
  }

  // `alignItems="center"` centers the heading and cards horizontally within the
  // full terminal width (the shell renders this in a full-width column).
  // `flexGrow={1}` makes the picker fill the frame, and the flex spacer pushes
  // the legend (and the optional footer flush beneath it) to the BOTTOM.
  return (
    <Box flexDirection="column" alignItems="center" flexGrow={1} marginTop={1}>
      <Text bold>Which platform do you want to set up?</Text>
      <Box flexDirection="row" gap={3} marginTop={1}>
        <PlatformCard emoji="🍎" name="iOS" hint="Apple App Store" selected={selected === 'ios'} />
        <PlatformCard emoji="🤖" name="Android" hint="Google Play" selected={selected === 'android'} />
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>←  →  choose   ·   Enter  confirm</Text>
      {footer}
    </Box>
  )
}

// ── generic card chooser ─────────────────────────────────────────────────────
export interface CardChoice {
  value: string
  emoji: string
  name: string
  hint: string
}

// Pure keypress → action mapping for CardChooser (unit-testable). ←/h → move
// left, →/l → move right, a number 1..count → that card, Enter → confirm.
export type CardKeyAction
  = | { type: 'move', delta: number }
    | { type: 'jump', index: number }
    | { type: 'confirm' }
    | null

export function cardKeyAction(
  input: string,
  key: { leftArrow?: boolean, rightArrow?: boolean, return?: boolean },
  count: number,
): CardKeyAction {
  if (key.return)
    return { type: 'confirm' }
  if (key.leftArrow || input === 'h')
    return { type: 'move', delta: -1 }
  if (key.rightArrow || input === 'l')
    return { type: 'move', delta: 1 }
  const n = Number.parseInt(input, 10)
  if (!Number.isNaN(n) && n >= 1 && n <= count)
    return { type: 'jump', index: n - 1 }
  return null
}

export interface CardChooserProps {
  layout: PlatformPickerLayout
  question: string
  subtitle?: string
  options: CardChoice[]
  /** Index of the card highlighted on first render (default 0 = leftmost). */
  defaultIndex?: number
  /** Rendered directly below the legend (flush, no gap). */
  footer?: ReactNode
  onSelect: (value: string) => void
}

/** A heading + bordered cards (←/→/Enter) — or a Select on narrow terminals —
 *  for any small choice. Reuses PlatformCard so the boxes match the platform picker. */
export const CardChooser: FC<CardChooserProps> = ({ layout, question, subtitle, options, defaultIndex = 0, footer, onSelect }) => {
  const [index, setIndex] = useState(Math.max(0, Math.min(options.length - 1, defaultIndex)))
  const clamp = (i: number): number => Math.max(0, Math.min(options.length - 1, i))

  useInput((input, key) => {
    if (layout !== 'cards' || options.length === 0)
      return
    const action = cardKeyAction(input, key, options.length)
    if (!action)
      return
    if (action.type === 'confirm')
      onSelect((options[index] ?? options[0]).value)
    else if (action.type === 'jump')
      setIndex(clamp(action.index))
    else
      setIndex(i => clamp(i + action.delta))
  })

  if (layout === 'list') {
    return (
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text bold>{question}</Text>
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Box marginTop={1}>
          <Select
            options={options.map(o => ({ label: `${o.emoji}  ${o.name} — ${o.hint}`, value: o.value }))}
            onChange={onSelect}
          />
        </Box>
        <Box flexGrow={1} />
        {footer}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" alignItems="center" flexGrow={1} marginTop={1}>
      <Text bold>{question}</Text>
      {subtitle ? <Box marginTop={1}><Text dimColor>{subtitle}</Text></Box> : null}
      <Box flexDirection="row" gap={3} marginTop={1}>
        {options.map((o, i) => (
          <PlatformCard key={o.value} emoji={o.emoji} name={o.name} hint={o.hint} selected={index === i} />
        ))}
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>←  →  choose   ·   Enter  confirm</Text>
      {footer}
    </Box>
  )
}

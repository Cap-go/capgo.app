import type { FC, ReactNode } from 'react'
import type { PlatformPickerLayout } from './frame-fit.js'
// src/build/onboarding/ui/update-prompt.tsx
//
// The "A new version of @capgo/cli is available" prompt, rendered INSIDE the
// alt-screen wizard (by OnboardingShell) as the FIRST screen when an update is
// available. It deliberately mirrors PlatformPicker so it feels like the same
// wizard — same Header above it, same cards↔list responsiveness, same
// ←/→/Enter driving:
//   • `cards` — two bordered cards (Update now / Skip) side-by-side.
//   • `list`  — the shared @inkjs/ui Select, for narrow/short terminals.
// Both layouts accept an optional `footer` rendered DIRECTLY below the legend
// (inside the same flex column) so a caller note — e.g. the analytics opt-out
// line — sits flush under "← → choose · Enter confirm" instead of floating
// mid-screen with a gap. The actual install + re-exec happens AFTER Ink tears
// down (see command.ts); this component only collects the decision.
import { Select } from '@inkjs/ui'
import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'

export type UpdateChoice = 'update' | 'skip'

// Pure mapping from a keypress to a prompt action (extracted so the
// arrow/Enter logic is unit-testable without rendering). ←/h/1 → update,
// →/l/2 → skip, Enter → confirm the current selection.
export type UpdateKeyAction
  = | { type: 'select', choice: UpdateChoice }
    | { type: 'confirm' }
    | null

export function updatePromptKeyAction(
  input: string,
  key: { leftArrow?: boolean, rightArrow?: boolean, return?: boolean },
): UpdateKeyAction {
  if (key.return)
    return { type: 'confirm' }
  if (key.leftArrow || input === 'h' || input === '1')
    return { type: 'select', choice: 'update' }
  if (key.rightArrow || input === 'l' || input === '2')
    return { type: 'select', choice: 'skip' }
  return null
}

interface ChoiceCardProps {
  emoji: string
  name: string
  hint: string
  selected: boolean
}

const ChoiceCard: FC<ChoiceCardProps> = ({ emoji, name, hint, selected }) => (
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

export interface UpdatePromptProps {
  layout: PlatformPickerLayout
  currentVersion: string
  latestVersion: string
  onDecide: (choice: UpdateChoice) => void
  /** Rendered directly below the legend (flush, no gap). */
  footer?: ReactNode
}

export const UpdatePrompt: FC<UpdatePromptProps> = ({ layout, currentVersion, latestVersion, onDecide, footer }) => {
  const [selected, setSelected] = useState<UpdateChoice>('update')
  const heading = `A new version of @capgo/cli is available (${currentVersion} → ${latestVersion}). Update now?`

  // Arrow/Enter driving for the cards layout. In list layout the @inkjs/ui
  // Select owns input, so this handler no-ops (it stays registered to satisfy
  // the rules of hooks, but ignores keys).
  useInput((input, key) => {
    if (layout !== 'cards')
      return
    const action = updatePromptKeyAction(input, key)
    if (!action)
      return
    if (action.type === 'select')
      setSelected(action.choice)
    else
      onDecide(selected)
  })

  if (layout === 'list') {
    return (
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text bold>{heading}</Text>
        <Select
          options={[
            { label: '⬆️  Yes, update and continue', value: 'update' },
            { label: '⏭️  No, continue on the current version', value: 'skip' },
          ]}
          onChange={value => onDecide(value as UpdateChoice)}
        />
        <Box flexGrow={1} />
        {footer}
      </Box>
    )
  }

  // Matches PlatformPicker's cards layout: centered heading + cards at the top,
  // the key legend (and optional footer flush beneath it) pinned to the bottom
  // via a single flex spacer.
  return (
    <Box flexDirection="column" alignItems="center" flexGrow={1} marginTop={1}>
      <Text bold>{heading}</Text>
      <Box flexDirection="row" gap={3} marginTop={1}>
        <ChoiceCard emoji="⬆️" name="Update and continue" hint={`${currentVersion} → ${latestVersion}`} selected={selected === 'update'} />
        <ChoiceCard emoji="⏭️" name="Skip" hint={`Stay on ${currentVersion}`} selected={selected === 'skip'} />
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>←  →  choose   ·   Enter  confirm</Text>
      {footer}
    </Box>
  )
}

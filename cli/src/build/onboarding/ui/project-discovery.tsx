import type { FC } from 'react'
import type { BuilderProjectDiscovery, CapacitorProjectCandidate } from '../project-discovery.js'
import { Select } from '@inkjs/ui'
import { Box, Text, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { discoverCapacitorProjects } from '../project-discovery.js'
import { projectCandidateLabel } from '../project-selection.js'
import { PICKER_MIN_COLS, PICKER_MIN_ROWS, terminalFitsPicker } from '../min-terminal-size.js'
import { Header, SpinnerLine } from './components.js'
import { pickPlatformLayout } from './frame-fit.js'
import { CardChooser } from './platform-picker.js'
import { TerminalTooSmallPrompt } from './min-size-gate.js'
import { useTerminalSize } from './shell.js'

export type BuilderProjectDecision
  = { kind: 'selected', candidate: CapacitorProjectCandidate }
    | { kind: 'cancelled' }
    | { kind: 'not-found', nxDetected: boolean }

export interface BuilderProjectDiscoveryAppProps {
  searchRoot: string
  onDecision: (decision: BuilderProjectDecision) => void
}

function candidateSubtitle(candidate: CapacitorProjectCandidate): string | undefined {
  return candidate.appId ? `appId: ${candidate.appId}` : undefined
}

export const BuilderProjectDiscoveryApp: FC<BuilderProjectDiscoveryAppProps> = ({ searchRoot, onDecision }) => {
  const { cols, rows } = useTerminalSize()
  const [discovery, setDiscovery] = useState<BuilderProjectDiscovery | null>(null)
  const decided = useRef(false)

  const decide = useCallback((decision: BuilderProjectDecision) => {
    if (decided.current)
      return
    decided.current = true
    onDecision(decision)
  }, [onDecision])

  useEffect(() => {
    let active = true
    void discoverCapacitorProjects(searchRoot).then((result) => {
      if (!active)
        return
      if (result.candidates.length === 0) {
        decide({ kind: 'not-found', nxDetected: result.nxDetected })
        return
      }
      setDiscovery(result)
    })
    return () => {
      active = false
    }
  }, [searchRoot, decide])

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q')
      decide({ kind: 'cancelled' })
  })

  if (!terminalFitsPicker(cols, rows))
    return <TerminalTooSmallPrompt cols={cols} rows={rows} minCols={PICKER_MIN_COLS} minRows={PICKER_MIN_ROWS} />

  if (!discovery) {
    return (
      <Box flexDirection="column" minHeight={rows} padding={1}>
        <Header />
        <Box marginTop={1}>
          <SpinnerLine text="Looking for a Capacitor app in this workspace..." />
        </Box>
      </Box>
    )
  }

  if (discovery.candidates.length === 1) {
    const candidate = discovery.candidates[0]
    return (
      <Box flexDirection="column" minHeight={rows} padding={1}>
        <Header />
        <CardChooser
          layout={pickPlatformLayout(cols, rows)}
          question={`We found a Capacitor app at ${candidate.relativeDir}. Is this the correct app?`}
          subtitle={candidateSubtitle(candidate)}
          subtitleAlign="left"
          options={[
            { value: 'yes', emoji: '✓', name: 'Yes', hint: 'Use this Capacitor app' },
            { value: 'no', emoji: '←', name: 'No', hint: 'Exit without changing folders' },
          ]}
          onSelect={value => decide(value === 'yes' ? { kind: 'selected', candidate } : { kind: 'cancelled' })}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" minHeight={rows} padding={1}>
      <Header />
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text bold>Which Capacitor app do you want to set up?</Text>
        <Box marginTop={1}>
          <Select
            visibleOptionCount={Math.min(8, discovery.candidates.length)}
            options={discovery.candidates.map(candidate => ({
              label: projectCandidateLabel(candidate),
              value: candidate.dir,
            }))}
            onChange={(dir) => {
              const candidate = discovery.candidates.find(item => item.dir === dir)
              if (candidate)
                decide({ kind: 'selected', candidate })
            }}
          />
        </Box>
        <Box flexGrow={1} />
        <Text dimColor>↑  ↓  choose   ·   Enter  confirm   ·   Esc  exit</Text>
      </Box>
    </Box>
  )
}

export const BuilderProjectOpeningApp: FC<{ candidate: CapacitorProjectCandidate }> = ({ candidate }) => {
  const { rows } = useTerminalSize()
  return (
    <Box flexDirection="column" minHeight={rows} padding={1}>
      <Header />
      <Box marginTop={1}>
        <SpinnerLine text={`Opening ${candidate.relativeDir}${candidate.appId ? ` (${candidate.appId})` : ''}...`} />
      </Box>
    </Box>
  )
}

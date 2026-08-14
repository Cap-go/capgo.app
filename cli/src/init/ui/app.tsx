import type { InitCodeDiff, InitEncryptionSummary, InitRuntimeState, InitStreamingOutput } from '../runtime'
import { exit } from 'node:process'
import { Alert } from '@inkjs/ui'
import { Box, Text, useInput, useStdout } from 'ink'
import Spinner from 'ink-spinner'
import React, { useSyncExternalStore } from 'react'
import { INIT_CANCEL } from '../runtime'
import { CurrentStepSection, InitHeader, ProgressSection, PromptArea, ScreenIntro, SpinnerArea } from './components'

function StreamingOutputPanel({ output, width, rows }: Readonly<{ output: InitStreamingOutput, width: number, rows: number }>) {
  // Reserve rows for: header (3) + panel borders/title (4) + footer status (2)
  // + a tiny safety margin (2). The rest is log body.
  const visibleLineCount = Math.max(5, rows - 11)
  const visibleLines = output.lines.slice(-visibleLineCount)
  const borderColor
    = output.status === 'success'
      ? 'green'
      : output.status === 'error'
        ? 'red'
        : 'cyan'

  useInput((input, key) => {
    const continuePrompt = output.continuePrompt
    if (key.ctrl && input === 'c') {
      if (continuePrompt) {
        continuePrompt.resolve(INIT_CANCEL)
      }
      else if (output.onCancel) {
        output.onCancel?.()
      }
      else {
        exit(130)
      }
      return
    }
    if (continuePrompt && key.return)
      continuePrompt.resolve()
  })

  return (
    <Box flexDirection="column" marginTop={1} width={width} borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color={borderColor} bold>{output.title}</Text>
      <Text color="gray">{`  $ ${output.command}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleLines.length === 0
          ? (
              <Text color="gray" dimColor>(waiting for output...)</Text>
            )
          : (
              visibleLines.map((line, index) => {
                const trimmed = line.trimStart()
                const isSuccess = trimmed.startsWith('✔') || trimmed.startsWith('✓') || trimmed.startsWith('[success]')
                const isError = trimmed.startsWith('✖') || trimmed.startsWith('❌') || trimmed.startsWith('[error]') || trimmed.startsWith('ERROR')
                const isWarn = trimmed.startsWith('⚠') || trimmed.startsWith('[warn]') || trimmed.startsWith('WARN')
                const isInfo = trimmed.startsWith('ℹ') || trimmed.startsWith('[info]')
                const isCap = trimmed.startsWith('[capacitor]')
                const isPath = /^\s+[a-z]/.test(line) && (line.includes('/') || line.includes('\\'))
                const color
                  = isSuccess ? 'green'
                    : isError ? 'red'
                      : isWarn ? 'yellow'
                        : isInfo ? 'cyan'
                          : isCap ? 'blue'
                            : isPath ? 'gray'
                              : undefined
                const dim = isPath
                return (
                  <Text key={`stream-${index}`} color={color} dimColor={dim}>{line}</Text>
                )
              })
            )}
      </Box>
      <Box marginTop={1}>
        {output.status === 'running'
          ? (
              <Box>
                <Text color="cyan"><Spinner type="dots" /></Text>
                <Text>
                  {' '}
                  {output.statusMessage ?? 'Running...'}
                </Text>
              </Box>
            )
          : (
              <Text color={borderColor} bold>
                {output.status === 'success' ? '✓ ' : '✖ '}
                {output.statusMessage ?? (output.status === 'success' ? 'Done' : 'Failed')}
              </Text>
            )}
      </Box>
      {output.continuePrompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{output.continuePrompt.message}</Text>
        </Box>
      )}
    </Box>
  )
}

function encryptionPhaseColor(phase: InitEncryptionSummary['phase']): 'green' | 'yellow' | 'red' {
  switch (phase) {
    case 'enabled':
      return 'green'
    case 'failed':
      return 'red'
    case 'pending-sync':
    case 'skipped':
    default:
      return 'yellow'
  }
}

function EncryptionSummaryPanel({ summary, width }: Readonly<{ summary: InitEncryptionSummary, width: number }>) {
  const borderColor = encryptionPhaseColor(summary.phase)
  return (
    <Box flexDirection="column" marginTop={1} width={width} borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color={borderColor} bold>{summary.title}</Text>
      {summary.lines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {summary.lines.map((line, index) => (
            <Text key={`enc-${index}`} color="gray">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function CodeDiffPanel({ diff, width }: Readonly<{ diff: InitCodeDiff, width: number }>) {
  const title = diff.created
    ? `Created ${diff.filePath}`
    : `Updated ${diff.filePath}`
  const maxLineNumber = diff.lines.reduce((max, line) => Math.max(max, line.lineNumber), 0)
  const gutterWidth = Math.max(2, String(maxLineNumber).length)
  return (
    <Box flexDirection="column" marginTop={1} width={width} borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>{`📝 ${title}`}</Text>
      {diff.note !== undefined && (
        <Text color="gray">{`  ${diff.note}`}</Text>
      )}
      {diff.lines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {diff.lines.map((line, index) => {
            const marker = line.kind === 'add' ? '+' : ' '
            const lineNum = String(line.lineNumber).padStart(gutterWidth, ' ')
            const color = line.kind === 'add' ? 'green' : 'gray'
            return (
              <Text key={`diff-${index}`} color={color}>
                {`${marker} ${lineNum} │ ${line.text}`}
              </Text>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

interface InitInkAppProps {
  getSnapshot: () => InitRuntimeState
  subscribe: (listener: () => void) => () => void
  updatePromptError: (error?: string) => void
}

export default function InitInkApp({ getSnapshot, subscribe, updatePromptError }: Readonly<InitInkAppProps>) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 96
  const rows = stdout?.rows ?? 24
  const contentWidth = Math.max(0, columns - 6)

  useInput((input, key) => {
    const skip = snapshot.logSkip
    if (!skip)
      return
    if (key.ctrl && input === 'c') {
      skip.resolve()
      return
    }
    if (!key.ctrl && (input === 'c' || input === 'C'))
      skip.resolve()
  }, { isActive: Boolean(snapshot.logSkip) && !snapshot.prompt && !snapshot.streamingOutput })
  // Estimate how many terminal rows the code diff panel consumes so the log
  // area (and the prompt/spinner rendered after it) still fit in the viewport
  // on short terminals. Overhead covers the panel's marginTop, top/bottom
  // borders, title line, and the marginTop between title and line content.
  // Long lines that wrap are approximated by counting each line's wrap count.
  const diffPanelHeight = (() => {
    const diff = snapshot.codeDiff
    if (!diff)
      return 0
    const innerWidth = Math.max(1, contentWidth - 4)
    const wrappedLineRows = diff.lines.reduce((sum, line) => {
      const rendered = `  ${String(line.lineNumber)} │ ${line.text}`
      return sum + Math.max(1, Math.ceil(rendered.length / innerWidth))
    }, 0)
    const noteRows = diff.note !== undefined ? 1 : 0
    const linesBlockRows = diff.lines.length > 0 ? wrappedLineRows + 1 : 0
    // 1 (panel marginTop) + 2 (borders) + 1 (title) + noteRows + linesBlockRows
    return 4 + noteRows + linesBlockRows
  })()
  // Same overhead math as the diff panel: marginTop + borders + title +
  // (optional) lines block. Wrap-aware so long bullet lines don't push the
  // prompt off-screen on narrow terminals.
  const encryptionPanelHeight = (() => {
    const summary = snapshot.encryptionSummary
    if (!summary)
      return 0
    const innerWidth = Math.max(1, contentWidth - 4)
    const wrappedLineRows = summary.lines.reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(line.length / innerWidth))
    }, 0)
    const linesBlockRows = summary.lines.length > 0 ? wrappedLineRows + 1 : 0
    // 1 (panel marginTop) + 2 (borders) + 1 (title) + linesBlockRows
    return 4 + linesBlockRows
  })()
  // `Array.prototype.slice(-0)` returns the full array because `-0` coerces
  // to `0`, so we cannot feed a zero clamp into slice — explicitly short-
  // circuit to an empty array when there's no viewport budget left for logs.
  const visibleLogCount = Math.max(0, rows - 14 - diffPanelHeight - encryptionPanelHeight)
  const visibleLogs = visibleLogCount === 0 ? [] : snapshot.logs.slice(-visibleLogCount)
  const screen = snapshot.screen

  // When a streaming command is running we hand the entire viewport over to
  // the streaming panel — no progress bar, no logs, no prompt. This keeps
  // long-lived `cap sync` output visible without fighting the normal
  // onboarding chrome for space. The InitHeader stays so the user knows
  // they're still inside `capgo init`.
  if (snapshot.streamingOutput) {
    return (
      <Box flexDirection="column" padding={1} width={columns}>
        {screen ? <InitHeader title={screen.headerTitle} /> : null}
        <StreamingOutputPanel
          output={snapshot.streamingOutput}
          width={contentWidth}
          rows={rows}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1} width={columns}>
      {screen ? <InitHeader title={screen.headerTitle} /> : null}

      {snapshot.versionWarning && (
        <Box marginTop={1} width={contentWidth}>
          <Alert variant="warning">
            You are using @capgo/cli@{snapshot.versionWarning.currentVersion} — update to @capgo/cli@{snapshot.versionWarning.latestVersion} or @capgo/cli@{snapshot.versionWarning.majorVersion}
          </Alert>
        </Box>
      )}

      {screen?.introLines?.length || screen?.title
        ? <ScreenIntro screen={screen} />
        : null}

      {screen && <ProgressSection screen={screen} />}

      {screen && <CurrentStepSection screen={screen} />}

      {snapshot.codeDiff && (
        <CodeDiffPanel diff={snapshot.codeDiff} width={contentWidth} />
      )}

      {snapshot.encryptionSummary && (
        <EncryptionSummaryPanel summary={snapshot.encryptionSummary} width={contentWidth} />
      )}

      {visibleLogs.length > 0 && (
        <Box flexDirection="column" marginTop={1} width={contentWidth}>
          {visibleLogs.map((entry, index) => (
            <Text key={`${entry.message}-${index}`} color={entry.tone}>{entry.message}</Text>
          ))}
        </Box>
      )}

      <Box width={contentWidth}>
        <PromptArea prompt={snapshot.prompt} onTextError={updatePromptError} />
      </Box>

      <Box width={contentWidth}>
        <SpinnerArea text={snapshot.spinner} skipHint={snapshot.logSkip?.hint} />
      </Box>
    </Box>
  )
}

import type { FC, ReactNode } from 'react'
import type { BuilderAppSelectionServices, BuilderVisibleApp } from '../app-selection.js'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppSelectionError, rankVisibleApps } from '../app-selection.js'
import { PICKER_MIN_COLS, PICKER_MIN_ROWS, terminalFitsPicker } from '../min-terminal-size.js'
import { Header } from './components.js'
import { TerminalTooSmallPrompt } from './min-size-gate.js'

type View = 'loading' | 'main' | 'all' | 'dashboard' | 'verifying' | 'error'
type Choice = { kind: 'app', app: BuilderVisibleApp, source: 'closest_list' | 'full_list' } | { kind: 'all' | 'login' | 'dashboard' | 'retry' | 'back' }

export interface AppSelectionEvent {
  phase: 'shown' | 'resolved' | 'error'
  result?: 'exact_match' | 'selected' | 'list' | 'read' | 'missing' | 'build' | 'permission' | 'config' | 'api'
  source?: 'closest_list' | 'full_list'
  visibleCount: number
}

export interface BuilderAppSelectionGateProps {
  apikey: string
  suggestedId: string
  suggestedSource: 'builder' | 'capacitor'
  services: BuilderAppSelectionServices
  cols: number
  rows: number
  footer?: ReactNode
  onSelected: (appId: string) => void
  onSwitchKey: () => void
  onCancel: () => void
  onEvent?: (event: AppSelectionEvent) => void
}

function visibleAppLabel(app: BuilderVisibleApp): string {
  return app.name && app.name !== app.app_id ? `${app.name} · ${app.app_id}` : app.app_id
}

function errorMessage(error: unknown): string {
  if (error instanceof AppSelectionError)
    return error.message
  return error instanceof Error ? error.message : 'Could not check Capgo apps. Please retry.'
}

const BuilderAppSelectionGate: FC<BuilderAppSelectionGateProps> = ({ apikey, suggestedId, suggestedSource, services, cols, rows, footer, onSelected, onSwitchKey, onCancel, onEvent }) => {
  const [view, setView] = useState<View>('loading')
  const [apps, setApps] = useState<BuilderVisibleApp[]>([])
  const [index, setIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [retrySelection, setRetrySelection] = useState<{ app: BuilderVisibleApp, source?: 'closest_list' | 'full_list' } | undefined>()
  const [dashboardOpened, setDashboardOpened] = useState(true)
  const active = useRef(true)
  const request = useRef(0)
  const eventCallback = useRef(onEvent)
  eventCallback.current = onEvent
  const selectedCallback = useRef(onSelected)
  selectedCallback.current = onSelected

  const emit = (event: AppSelectionEvent) => eventCallback.current?.(event)

  const verifyAndSelect = useCallback(async (app: BuilderVisibleApp, source?: 'closest_list' | 'full_list', count = 0) => {
    const requestId = ++request.current
    setRetrySelection({ app, source })
    setView('verifying')
    try {
      await services.verify(apikey, app.app_id)
      await services.persist(app.app_id)
      if (!active.current || requestId !== request.current)
        return
      selectedCallback.current(app.app_id)
      emit({ phase: 'resolved', result: source ? 'selected' : 'exact_match', source, visibleCount: count })
    }
    catch (cause) {
      if (!active.current || requestId !== request.current)
        return
      const category = cause instanceof AppSelectionError ? cause.code : 'permission'
      emit({ phase: 'error', result: category, visibleCount: count })
      setError(errorMessage(cause))
      setView('error')
    }
  }, [apikey, services])

  const load = useCallback(async () => {
    const requestId = ++request.current
    setView('loading')
    setError('')
    setApps([])
    try {
      const visible = await services.list(apikey)
      if (!active.current || requestId !== request.current)
        return
      const ranked = rankVisibleApps(visible, suggestedId)
      setApps(ranked)
      setIndex(0)
      const match = ranked.find(app => app.app_id === suggestedId)
      if (match) {
        await verifyAndSelect(match, undefined, ranked.length)
        return
      }
      emit({ phase: 'shown', visibleCount: ranked.length })
      setRetrySelection(undefined)
      setView('main')
    }
    catch (cause) {
      if (!active.current || requestId !== request.current)
        return
      emit({ phase: 'error', result: 'list', visibleCount: 0 })
      setRetrySelection(undefined)
      setError(errorMessage(cause))
      setView('error')
    }
  }, [apikey, services, suggestedId, verifyAndSelect])

  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
      request.current++
    }
  }, [load])

  const firstChoices: Choice[] = [
    ...apps.slice(0, 3).map(app => ({ kind: 'app' as const, app, source: 'closest_list' as const })),
    ...(apps.length > 1 ? [{ kind: 'all' as const }] : []),
    { kind: 'login' },
    ...(services.dashboardUrl ? [{ kind: 'dashboard' as const }] : []),
  ]
  const filteredApps = apps.filter(app => `${app.name ?? ''} ${app.app_id}`.toLowerCase().includes(query.toLowerCase()))
  const allChoices: Choice[] = [
    ...filteredApps.map(app => ({ kind: 'app' as const, app, source: 'full_list' as const })),
    { kind: 'back' },
  ]
  const errorChoices: Choice[] = [
    { kind: 'retry' },
    ...(apps.length ? [{ kind: 'back' as const }] : []),
    { kind: 'login' },
  ]
  const choices = view === 'main' ? firstChoices : view === 'all' ? allChoices : view === 'error' ? errorChoices : []
  const boundedIndex = Math.min(index, Math.max(choices.length - 1, 0))

  const choose = (choice: Choice) => {
    if (choice.kind === 'app') {
      void verifyAndSelect(choice.app, choice.source, apps.length)
    }
    else if (choice.kind === 'all') {
      setQuery('')
      setIndex(0)
      setView('all')
    }
    else if (choice.kind === 'login') {
      onSwitchKey()
    }
    else if (choice.kind === 'dashboard') {
      setView('dashboard')
      void services.openDashboard().then(opened => setDashboardOpened(opened)).catch(() => setDashboardOpened(false))
    }
    else if (choice.kind === 'retry') {
      if (retrySelection)
        void verifyAndSelect(retrySelection.app, retrySelection.source, apps.length)
      else
        void load()
    }
    else {
      setIndex(0)
      setView('main')
    }
  }

  useInput((input, key) => {
    if (key.escape) {
      if (view === 'main')
        onCancel()
      else if (view === 'error' && apps.length === 0)
        onCancel()
      else if (view === 'all' || view === 'dashboard' || view === 'error') {
        setIndex(0)
        setView('main')
      }
      return
    }
    if (view === 'dashboard') {
      if (key.return)
        void load()
      return
    }
    if (view !== 'main' && view !== 'all' && view !== 'error')
      return
    if (key.upArrow || (view !== 'all' && input === 'k')) {
      setIndex(value => Math.max(0, value - 1))
      return
    }
    if (key.downArrow || (view !== 'all' && input === 'j')) {
      setIndex(value => Math.min(choices.length - 1, value + 1))
      return
    }
    if (key.return) {
      const choice = choices[boundedIndex]
      if (choice)
        choose(choice)
      return
    }
    if (view === 'all') {
      if (key.backspace || key.delete) {
        setQuery(value => value.slice(0, -1))
        setIndex(0)
      }
      else if (!key.ctrl && !key.meta && !key.tab && input && !key.leftArrow && !key.rightArrow) {
        setQuery(value => value + input)
        setIndex(0)
      }
    }
  })

  if (!terminalFitsPicker(cols, rows))
    return <TerminalTooSmallPrompt cols={cols} rows={rows} minCols={PICKER_MIN_COLS} minRows={PICKER_MIN_ROWS} />

  const compact = cols < 64 || rows < 18
  const showDivider = !compact && rows >= 20
  const optionLimit = compact ? Math.max(1, rows - 9) : Math.max(3, rows - (showDivider ? 18 : 16))
  const start = Math.max(0, boundedIndex - optionLimit + 1)
  const visibleChoices = choices.slice(start, start + optionLimit)
  const suggestionLabel = suggestedSource === 'builder' ? 'Your Builder app ID:' : 'Your Capacitor app ID:'

  return (
    <Box flexDirection="column" minHeight={rows} padding={compact ? 0 : 1}>
      {compact ? <Text bold color="cyan">Capgo Cloud Build · Onboarding</Text> : <Header />}
      {(view === 'loading' || view === 'verifying') && (
        <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>{view === 'loading' ? 'Checking Capgo apps…' : 'Checking app access…'}</Text>
        </Box>
      )}
      {(view === 'main' || view === 'all') && (
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          <Text bold>Which Capgo app should Builder use?</Text>
          <Text wrap="truncate-middle">{`${suggestionLabel} ${suggestedId}`}</Text>
          <Text color="yellow">No app with this ID is available to your API key. It may exist in Capgo, but you or your API key might lack access to it.</Text>
          {view === 'all'
            ? <Text dimColor wrap="truncate-end">{`Search visible apps: ${query}█`}</Text>
            : <Text dimColor>{apps.length === 0 ? 'No apps are visible to this API key.' : apps.length === 1 ? 'App visible to your API key:' : 'Apps visible to your API key (closest IDs first):'}</Text>}
        </Box>
      )}
      {view === 'error' && <Box flexDirection="column" marginTop={1}><Text bold color="red">{retrySelection ? 'Could not continue with this app' : 'Could not load Capgo apps'}</Text><Text color="red">{error}</Text></Box>}
      {view === 'dashboard' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Open Dashboard to create {suggestedId}</Text>
          <Text>{dashboardOpened ? 'Create the app in your browser, then return here.' : 'Open this URL in your browser:'}</Text>
          {!dashboardOpened && <Text color="cyan" wrap="wrap">{services.dashboardUrl}</Text>}
          <Text color="green">❯ I've created it — check again</Text>
          <Text dimColor>Enter checks again · Esc goes back</Text>
        </Box>
      )}
      {(view === 'main' || view === 'all' || view === 'error') && (
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          {showDivider && (view === 'main' || view === 'all') && <Text dimColor>{'─'.repeat(Math.min(76, cols - 2))}</Text>}
          {view === 'all' && filteredApps.length === 0 && <Text dimColor>No matching apps</Text>}
          {visibleChoices.map((choice, offset) => {
            const selected = start + offset === boundedIndex
            const label = choice.kind === 'app' ? visibleAppLabel(choice.app)
              : choice.kind === 'all' ? 'Select a different app…'
                : choice.kind === 'login' ? 'Log in with another API key'
                  : choice.kind === 'dashboard' ? `Open Dashboard to create ${suggestedId}`
                    : choice.kind === 'retry' ? 'Retry'
                      : 'Back to suggested apps'
            return <Text key={`${choice.kind}-${choice.kind === 'app' ? choice.app.app_id : ''}`} color={selected ? 'green' : undefined} bold={selected} wrap="truncate-middle">{`${selected ? '❯' : ' '} ${label}`}</Text>
          })}
          {compact && choices.length > optionLimit && <Text dimColor>↑ ↓ more choices</Text>}
          {!compact && <Box marginTop={showDivider ? 1 : 0}><Text dimColor>↑ ↓ choose · Enter select · Esc back</Text></Box>}
        </Box>
      )}
      {!compact && footer}
    </Box>
  )
}

export default BuilderAppSelectionGate

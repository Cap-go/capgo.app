import type { FC, ReactNode } from 'react'
import type { BrowserLoginSession } from '../../../init/browser-login.js'
import type { BuilderLoginServices } from '../login.js'
import { Select } from '@inkjs/ui'
import { Box, Text, useInput } from 'ink'
import React, { useEffect, useRef, useState } from 'react'
import { Header, FilteredTextInput, SpinnerLine } from './components.js'
import { pickPlatformLayout } from './frame-fit.js'
import { CardChooser } from './platform-picker.js'

type LoginMethod = 'browser' | 'paste'
type LoginView = 'checking' | 'candidate-error' | 'choice' | 'opening' | 'entry' | 'verifying'

export interface BuilderLoginMetadata {
  method?: LoginMethod
  retryCount: number
  durationMs: number
}

export interface BuilderLoginGateProps {
  candidateKey?: string
  services: BuilderLoginServices
  cols: number
  rows: number
  footer?: ReactNode
  onAuthenticated: (key: string, metadata: BuilderLoginMetadata) => void
  onCancel: () => void
}

const BuilderLoginGate: FC<BuilderLoginGateProps> = ({ candidateKey, services, cols, rows, footer, onAuthenticated, onCancel }) => {
  const [view, setView] = useState<LoginView>(candidateKey ? 'checking' : services.browserAvailable ? 'choice' : 'entry')
  const [method, setMethod] = useState<LoginMethod | undefined>(services.browserAvailable ? undefined : 'paste')
  const [session, setSession] = useState<BrowserLoginSession | undefined>()
  const [browserUrl, setBrowserUrl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [inputRevision, setInputRevision] = useState(0)
  const attempts = useRef(0)
  const shownAt = useRef(Date.now())
  const cancelled = useRef(false)
  const authenticatedCallback = useRef(onAuthenticated)
  authenticatedCallback.current = onAuthenticated
  const compact = cols < 64 || rows < 18

  useEffect(() => {
    if (!candidateKey)
      return
    void services.validateExisting(candidateKey)
      .then(() => {
        if (!cancelled.current)
          authenticatedCallback.current(candidateKey, { retryCount: 0, durationMs: 0 })
      })
      .catch(() => {
        if (!cancelled.current) {
          setError("We couldn't verify this API key. Retry or use another key.")
          setView('candidate-error')
        }
      })
    return () => { cancelled.current = true }
  }, [candidateKey, services])

  const cancel = () => {
    cancelled.current = true
    onCancel()
  }

  const retryCandidate = () => {
    if (!candidateKey)
      return
    setError(undefined)
    setView('checking')
    void services.validateExisting(candidateKey)
      .then(() => {
        if (!cancelled.current)
          authenticatedCallback.current(candidateKey, { retryCount: 0, durationMs: 0 })
      })
      .catch(() => {
        if (!cancelled.current) {
          setError("We couldn't verify this API key. Retry or use another key.")
          setView('candidate-error')
        }
      })
  }

  const chooseMethod = (choice: string) => {
    if (choice !== 'browser' && choice !== 'paste')
      return
    setMethod(choice)
    setError(undefined)
    if (choice === 'paste') {
      setView('entry')
      return
    }
    if (session) {
      setBrowserUrl(session.url)
      setView('entry')
      return
    }
    setView('opening')
    void services.beginBrowser(setBrowserUrl)
      .then((openedSession) => {
        if (cancelled.current)
          return
        setSession(openedSession)
        setView('entry')
      })
      .catch(() => {
        if (!cancelled.current) {
          setError('Could not open the dashboard. Select a login method to try again.')
          setView('choice')
        }
      })
  }

  const submit = (value: string) => {
    const key = value.trim()
    if (!key) {
      setError('API key is required.')
      return
    }
    attempts.current += 1
    setError(undefined)
    setView('verifying')
    const verify = method === 'browser' && session
      ? services.completeBrowser(session, key)
      : services.savePasted(key)
    void verify
      .then(() => {
        if (!cancelled.current) {
          onAuthenticated(key, {
            method: method ?? 'paste',
            retryCount: attempts.current - 1,
            durationMs: Date.now() - shownAt.current,
          })
        }
      })
      .catch(() => {
        if (!cancelled.current) {
          setInputRevision(revision => revision + 1)
          setError("We couldn't verify that key. Paste another key and try again.")
          setView('entry')
        }
      })
  }

  useInput((_input, key) => {
    if (key.escape)
      cancel()
    else if (key.tab && view === 'entry' && services.browserAvailable) {
      setError(undefined)
      setView('choice')
    }
  })

  const choiceOptions = [
    { value: 'browser', emoji: '🌎', name: 'Open browser', hint: 'Create key in Dashboard' },
    { value: 'paste', emoji: '📋', name: 'Paste API key', hint: 'Use an existing key' },
  ]

  return (
    <Box flexDirection="column" minHeight={rows} padding={1}>
      {compact
        ? <Text bold color="cyan">Capgo Cloud Build · Login</Text>
        : <Header />}
      {view === 'checking' && <Box marginTop={1}><SpinnerLine text="Checking Capgo login…" /></Box>}
      {view === 'candidate-error' && (compact
        ? (
            <Box flexDirection="column">
              <Text bold>We couldn't verify your Capgo login.</Text>
              <Select
                options={[
                  { value: 'retry', label: '🔄 Retry key' },
                  { value: 'another', label: '📋 Use another key' },
                ]}
                onChange={(choice) => {
                  if (choice === 'retry')
                    retryCandidate()
                  else {
                    setMethod(services.browserAvailable ? undefined : 'paste')
                    setError(undefined)
                    setView(services.browserAvailable ? 'choice' : 'entry')
                  }
                }}
              />
            </Box>
          )
        : <CardChooser
          layout={pickPlatformLayout(cols, rows)}
          question="We couldn't verify your Capgo login."
          subtitle={error}
          options={[
            { value: 'retry', emoji: '🔄', name: 'Retry key', hint: 'Check connection' },
            { value: 'another', emoji: '📋', name: 'Use another key', hint: 'Log in again' },
          ]}
          onSelect={(choice) => {
            if (choice === 'retry')
              retryCandidate()
            else {
              setMethod(services.browserAvailable ? undefined : 'paste')
              setError(undefined)
              setView(services.browserAvailable ? 'choice' : 'entry')
            }
          }}
          footer={compact ? undefined : footer}
          />
      )}
      {view === 'choice' && (compact
        ? (
            <Box flexDirection="column">
              <Text bold>How would you like to log in?</Text>
              <Select
                options={[
                  { value: 'browser', label: '🌎 Open browser' },
                  { value: 'paste', label: '📋 Paste API key' },
                ]}
                onChange={chooseMethod}
              />
            </Box>
          )
        : <CardChooser
          layout={pickPlatformLayout(cols, rows)}
          question="How would you like to log in?"
          options={choiceOptions}
          onSelect={chooseMethod}
          footer={compact ? undefined : footer}
          />
      )}
      {view === 'opening' && <Box marginTop={1}><SpinnerLine text="Opening the Capgo Dashboard…" /></Box>}
      {view === 'verifying' && <Box marginTop={1}><SpinnerLine text="Checking API key…" /></Box>}
      {view === 'entry' && (
        <Box flexDirection="column" marginTop={compact ? 0 : 2} alignItems={compact ? 'flex-start' : 'center'}>
          <Text bold>Paste the API key from the Capgo Dashboard</Text>
          {method === 'browser' && browserUrl && (
            <Box flexDirection="column" marginTop={compact ? 0 : 1}>
              <Text dimColor>{session?.browserOpened ? 'Dashboard URL:' : 'Open this URL in your browser:'}</Text>
              <Text>{browserUrl}</Text>
            </Box>
          )}
          <Box
            borderStyle={compact ? undefined : 'round'}
            borderColor={compact ? undefined : 'cyan'}
            paddingX={compact ? 0 : 1}
            width={compact ? undefined : Math.min(cols - 4, 56)}
            marginTop={compact ? 0 : 1}
          >
            <FilteredTextInput key={inputRevision} filter="" mask maxMaskWidth={Math.max(8, Math.min(24, cols - 8))} onSubmit={submit} />
          </Box>
          {error && <Text color="red">{error}</Text>}
          <Text dimColor>{services.browserAvailable ? 'Enter verify · Tab change method · Esc cancel' : 'Enter verify · Esc cancel'}</Text>
          {!compact && footer}
        </Box>
      )}
    </Box>
  )
}

export default BuilderLoginGate

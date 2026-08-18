import process, { stdout } from 'node:process'
import { render } from 'ink'
import React from 'react'
import InitInkApp from './ui/app'

export const INIT_CANCEL = Symbol('init-cancel')

export type InitLogTone = 'cyan' | 'yellow' | 'green' | 'red'

export type InitScreenTone = 'cyan' | 'blue' | 'green' | 'yellow'

export interface InitScreen {
  headerTitle?: string
  title?: string
  introLines?: string[]
  phaseLabel?: string
  progress?: number
  stepLabel?: string
  stepSummary?: string
  roadmapLine?: string
  statusLine?: string
  resumeLine?: string
  completionLines?: string[]
  tone?: InitScreenTone
}

export interface ConfirmPrompt {
  kind: 'confirm'
  message: string
  initialValue?: boolean
  resolve: (value: boolean | symbol) => void
}

export interface TextPrompt {
  kind: 'text'
  mask?: string
  message: string
  placeholder?: string
  validate?: (value: string | undefined) => string | undefined
  error?: string
  resolve: (value: string | symbol) => void
}

export interface SelectPromptOption {
  label: string
  hint?: string
  value: string
}

export interface SelectPrompt {
  kind: 'select'
  message: string
  options: SelectPromptOption[]
  resolve: (value: string | symbol) => void
}

export type PromptRequest = ConfirmPrompt | TextPrompt | SelectPrompt

export interface InitLogEntry {
  message: string
  tone: InitLogTone
}

export interface InitVersionWarning {
  currentVersion: string
  latestVersion: string
  majorVersion: string
}

export interface InitCodeDiffLine {
  lineNumber: number
  text: string
  kind: 'context' | 'add'
}

export interface InitCodeDiff {
  filePath: string
  created: boolean
  lines: InitCodeDiffLine[]
  note?: string
}

export type InitEncryptionPhase = 'enabled' | 'pending-sync' | 'skipped' | 'failed'

export interface InitEncryptionSummary {
  phase: InitEncryptionPhase
  title: string
  lines: string[]
}

export type InitStreamingOutputStatus = 'running' | 'success' | 'error'

export interface InitStreamingOutput {
  title: string
  command: string
  lines: string[]
  status: InitStreamingOutputStatus
  statusMessage?: string
  onCancel?: () => void
  continuePrompt?: {
    message: string
    resolve: (value: void | symbol) => void
  }
}

export interface InitLogSkip {
  hint: string
  resolve: () => void
}

export interface InitRuntimeState {
  screen?: InitScreen
  logs: InitLogEntry[]
  spinner?: string
  prompt?: PromptRequest
  versionWarning?: InitVersionWarning
  codeDiff?: InitCodeDiff
  encryptionSummary?: InitEncryptionSummary
  streamingOutput?: InitStreamingOutput
  logSkip?: InitLogSkip
}

let state: InitRuntimeState = {
  logs: [],
}

const listeners = new Set<() => void>()
let inkApp: ReturnType<typeof render> | undefined
let started = false
let keepAliveTimer: ReturnType<typeof setInterval> | undefined
function emit() {
  listeners.forEach(listener => listener())
}

function updateState(updater: (current: InitRuntimeState) => InitRuntimeState) {
  state = updater(state)
  emit()
}

function clearPrompt() {
  updateState(current => ({ ...current, prompt: undefined }))
}

function createPromptResolver<T>(resolve: (value: T | symbol | PromiseLike<T | symbol>) => void): (value: T | symbol) => void {
  return (value: T | symbol) => {
    clearPrompt()
    resolve(value)
  }
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getInitSnapshot() {
  return state
}

export function ensureInitInkSession() {
  if (started)
    return
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('`capgo init` requires an interactive terminal. It cannot run in CI, pipes, or non-TTY environments.')

  started = true
  inkApp = render(React.createElement(InitInkApp, {
    getSnapshot: getInitSnapshot,
    subscribe,
    updatePromptError,
  }), { exitOnCtrlC: false })
  keepAliveTimer ??= setInterval(() => {}, 1000)
}

export function stopInitInkSession(finalMessage?: { text: string, tone: 'green' | 'yellow' }) {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = undefined
  }
  if (inkApp) {
    inkApp.unmount()
    inkApp = undefined
  }
  started = false
  state = { screen: undefined, logs: [], spinner: undefined, prompt: undefined, codeDiff: undefined, encryptionSummary: undefined, streamingOutput: undefined, logSkip: undefined }
  if (finalMessage)
    stdout.write(`${finalMessage.text}\n`)
}

export function setInitScreen(screen: InitScreen) {
  updateState(current => ({ ...current, screen }))
  ensureInitInkSession()
}

export function pushInitLog(message: string, tone: InitLogTone) {
  ensureInitInkSession()
  updateState(current => ({
    ...current,
    logs: [...current.logs, { message, tone }],
  }))
}

export function clearInitLogs() {
  ensureInitInkSession()
  updateState(current => ({
    ...current,
    logs: [],
  }))
}

export function setInitSpinner(message?: string) {
  ensureInitInkSession()
  updateState(current => ({ ...current, spinner: message }))
}

export function requestInitConfirm(message: string, initialValue?: boolean): Promise<boolean | symbol> {
  ensureInitInkSession()
  return new Promise((resolve) => {
    updateState(current => ({
      ...current,
      prompt: {
        kind: 'confirm',
        message,
        initialValue,
        resolve: createPromptResolver(resolve),
      },
    }))
  })
}

export function requestInitText(message: string, placeholder?: string, validate?: (value: string | undefined) => string | undefined, mask?: string): Promise<string | symbol> {
  ensureInitInkSession()
  return new Promise((resolve) => {
    updateState(current => ({
      ...current,
      prompt: {
        kind: 'text',
        mask,
        message,
        placeholder,
        validate,
        resolve: createPromptResolver(resolve),
      },
    }))
  })
}

export function requestInitSelect(message: string, options: SelectPromptOption[]): Promise<string | symbol> {
  ensureInitInkSession()
  return new Promise((resolve) => {
    updateState(current => ({
      ...current,
      prompt: {
        kind: 'select',
        message,
        options,
        resolve: createPromptResolver(resolve),
      },
    }))
  })
}

export function setInitCodeDiff(diff?: InitCodeDiff) {
  ensureInitInkSession()
  updateState(current => ({ ...current, codeDiff: diff }))
}

export function setInitEncryptionSummary(summary?: InitEncryptionSummary) {
  ensureInitInkSession()
  updateState(current => ({ ...current, encryptionSummary: summary }))
}

export function startInitStreamingOutput(params: { title: string, command: string, onCancel?: () => void }) {
  ensureInitInkSession()
  updateState(current => ({
    ...current,
    streamingOutput: {
      title: params.title,
      command: params.command,
      lines: [],
      status: 'running',
      statusMessage: undefined,
      onCancel: params.onCancel,
    },
  }))
}

export function appendInitStreamingLine(line: string) {
  ensureInitInkSession()
  updateState((current) => {
    if (!current.streamingOutput)
      return current
    return {
      ...current,
      streamingOutput: {
        ...current.streamingOutput,
        lines: [...current.streamingOutput.lines, line],
      },
    }
  })
}

export function updateInitStreamingStatus(status: InitStreamingOutputStatus, statusMessage?: string) {
  ensureInitInkSession()
  updateState((current) => {
    if (!current.streamingOutput)
      return current
    return {
      ...current,
      streamingOutput: {
        ...current.streamingOutput,
        status,
        statusMessage,
      },
    }
  })
}

export function waitForInitLogSkip(hint: string, signal?: AbortSignal): Promise<void> {
  ensureInitInkSession()
  return new Promise((resolve) => {
    const finish = () => {
      signal?.removeEventListener('abort', finish)
      updateState(active => ({ ...active, logSkip: undefined }))
      resolve()
    }
    if (signal?.aborted) {
      resolve()
      return
    }
    signal?.addEventListener('abort', finish, { once: true })
    updateState(current => ({
      ...current,
      logSkip: {
        hint,
        resolve: finish,
      },
    }))
  })
}

export function waitForInitStreamingContinue(message: string): Promise<void | symbol> {
  ensureInitInkSession()
  return new Promise((resolve) => {
    updateState((current) => {
      if (!current.streamingOutput)
        return current
      return {
        ...current,
        streamingOutput: {
          ...current.streamingOutput,
          continuePrompt: {
            message,
            resolve: (value) => {
              updateState(active => ({
                ...active,
                streamingOutput: active.streamingOutput
                  ? { ...active.streamingOutput, continuePrompt: undefined }
                  : undefined,
              }))
              resolve(value)
            },
          },
        },
      }
    })
  })
}

export function clearInitStreamingOutput() {
  ensureInitInkSession()
  updateState(current => ({ ...current, streamingOutput: undefined }))
}

export function setInitVersionWarning(currentVersion: string, latestVersion: string, majorVersion: string) {
  updateState(current => ({
    ...current,
    versionWarning: { currentVersion, latestVersion, majorVersion },
  }))
}

function updatePromptError(error?: string) {
  updateState((current) => {
    if (current.prompt?.kind !== 'text')
      return current
    return {
      ...current,
      prompt: {
        ...current.prompt,
        error,
      },
    }
  })
}

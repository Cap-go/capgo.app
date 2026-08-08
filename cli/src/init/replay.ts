import type { eventWithTime, fullSnapshotEvent, incrementalSnapshotEvent, metaEvent, serializedNodeWithId } from '@rrweb/types'
import { randomUUID } from 'node:crypto'
import type { Document as HappyDocument } from 'happy-dom'
import { env, stderr, stdin, stdout } from 'node:process'
import { EventType, IncrementalSource, MouseInteractions, PointerTypes } from '@rrweb/types'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { isCI } from 'ci-info'
import { Window } from 'happy-dom'
import { snapshot } from 'rrweb-snapshot'
import pack from '../../package.json'
import { isTruthyEnvValue } from '../posthog'
import { redactSecrets } from '../support/redact'
import { defaultApiHost, getRemoteConfig } from '../utils'

const DEFAULT_REPLAY_API_HOST = defaultApiHost
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30
const REPLAY_CHAR_WIDTH_PX = 9
const REPLAY_LINE_HEIGHT_PX = 20
const REPLAY_PADDING_PX = 32
const REPLAY_FRAME_THROTTLE_MS = 1000
const REPLAY_FLUSH_TIMEOUT_MS = 1500
const DEFAULT_REPLAY_CURRENT_URL = 'capgo-cli://init'
const DEFAULT_REPLAY_SESSION_PREFIX = 'init'

type CliStream = typeof stdout | typeof stderr
type StreamWrite = CliStream['write']
interface TerminalSnapshot {
  node: serializedNodeWithId
  terminalNodeId: number
}

export interface TerminalReplayFrame {
  height: number
  html: string
  text: string
  width: number
}

export interface TerminalPixelSize {
  height: number
  width: number
}

interface InitReplayGateInput {
  analyticsEnabled?: boolean
  apikey?: string
  isCi?: boolean
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  telemetryDisabled?: boolean
}
interface InitReplaySnapshotBody {
  event: '$snapshot'
  properties: {
    $current_url: string
    $lib: string
    $lib_version: string
    $session_id: string
    $snapshot_bytes: number
    $snapshot_data: eventWithTime[]
    $snapshot_source: string
    $window_id: string
  }
  timestamp: string
}

type InitReplayTransport = (url: string, body: InitReplaySnapshotBody, apikey: string, signal?: AbortSignal) => Promise<boolean>

interface StartInitReplayOptions {
  analyticsEnabled?: boolean
  apikey?: string
  ariaLabel?: string
  cols?: number
  currentUrl?: string
  isCi?: boolean
  replayUrl?: string
  rows?: number
  sessionPrefix?: string
  supaAnon?: string
  supaHost?: string
  throttleMs?: number
  terminalPixelSize?: TerminalPixelSize
  transport?: InitReplayTransport
}

export interface InitReplayController {
  finish: () => Promise<void>
  sessionId: string
}

let activeReplayFinish: (() => Promise<void>) | undefined
let activeReplaySessionId: string | undefined

export function getActiveCliReplaySessionId() {
  return activeReplaySessionId
}

export async function finishActiveCliReplay() {
  await activeReplayFinish?.()
}

export function isCliTelemetryDisabled() {
  return isTruthyEnvValue(env.CAPGO_DISABLE_TELEMETRY) || isTruthyEnvValue(env.CAPGO_DISABLE_POSTHOG)
}

export function shouldStartInitReplay(input: InitReplayGateInput) {
  return Boolean(
    input.apikey?.trim()
    && input.analyticsEnabled !== false
    && input.stdinIsTTY
    && input.stdoutIsTTY
    && !input.isCi
    && !input.telemetryDisabled,
  )
}

export function resolveCapgoReplayUrl(host = env.CAPGO_CLI_REPLAY_API_HOST?.trim() || env.CAPGO_API_HOST?.trim() || DEFAULT_REPLAY_API_HOST) {
  const trimmedHost = host.trim()
  if (!trimmedHost)
    return undefined

  try {
    const withoutTrailingSlash = trimmedHost.replace(/\/+$/, '')
    if (withoutTrailingSlash.endsWith('/private/replay'))
      return withoutTrailingSlash

    return new URL('private/replay', withoutTrailingSlash.endsWith('/') ? withoutTrailingSlash : `${withoutTrailingSlash}/`).toString()
  }
  catch {
    return undefined
  }
}

export function resolveSupabaseReplayUrl(supaHost?: string) {
  const trimmedHost = supaHost?.trim()
  if (!trimmedHost)
    return undefined

  try {
    const withoutTrailingSlash = trimmedHost.replace(/\/+$/, '')
    if (withoutTrailingSlash.endsWith('/functions/v1/private/replay'))
      return withoutTrailingSlash

    return new URL('functions/v1/private/replay', `${withoutTrailingSlash}/`).toString()
  }
  catch {
    return undefined
  }
}

async function resolveConfiguredCapgoReplayUrl(signal?: AbortSignal) {
  const config = await getRemoteConfig(true, signal).catch(() => ({ hostApi: DEFAULT_REPLAY_API_HOST }))
  return resolveCapgoReplayUrl(config.hostApi)
}

export async function resolveReplayUrlForFlush(replayUrl: Promise<string | undefined>, timeoutMs = REPLAY_FLUSH_TIMEOUT_MS, onTimeout?: () => void) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      replayUrl.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          onTimeout?.()
          resolve(undefined)
        }, timeoutMs)
        timeout.unref?.()
      }),
    ])
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
  }
}

function isUsableTerminalPixelSize(size?: TerminalPixelSize): size is TerminalPixelSize {
  return Boolean(
    size
    && Number.isFinite(size.height)
    && Number.isFinite(size.width)
    && size.height > 0
    && size.width > 0,
  )
}

export function getReplayViewportSize(cols = DEFAULT_COLS, rows = DEFAULT_ROWS, terminalPixelSize?: TerminalPixelSize) {
  if (isUsableTerminalPixelSize(terminalPixelSize))
    return { height: Math.round(terminalPixelSize.height), width: Math.round(terminalPixelSize.width) }

  return {
    height: Math.max(480, Math.round(rows * REPLAY_LINE_HEIGHT_PX + REPLAY_PADDING_PX)),
    width: Math.max(800, Math.round(cols * REPLAY_CHAR_WIDTH_PX + REPLAY_PADDING_PX)),
  }
}

function createTerminal(cols: number, rows: number) {
  const term = new Terminal({
    allowProposedApi: true,
    cols,
    convertEol: true,
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    fontSize: 14,
    rows,
    theme: {
      background: '#0d1117',
      foreground: '#d6deeb',
    },
  } as unknown as ConstructorParameters<typeof Terminal>[0])
  const serializeAddon = new SerializeAddon()
  term.loadAddon(serializeAddon)
  return { serializeAddon, term }
}
function writeTerminal(term: Terminal, text: string) {
  return new Promise<void>((resolve) => {
    term.write(text, () => resolve())
  })
}

function chunkToString(chunk: unknown, encoding?: BufferEncoding) {
  if (typeof chunk === 'string')
    return chunk
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk).toString(encoding || 'utf8')
  return String(chunk ?? '')
}

function visibleTerminalText(term: Terminal) {
  const lines: string[] = []
  const buffer = term.buffer.active
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    const text = line?.translateToString(true) ?? ''
    if (line?.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
      continue
    }
    lines.push(text)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '')
    lines.pop()

  return lines.join('\n')
}

function extractHtmlFragment(html: string) {
  const startMarker = '<!--StartFragment-->'
  const endMarker = '<!--EndFragment-->'
  const start = html.indexOf(startMarker)
  const end = html.indexOf(endMarker)
  if (start === -1 || end === -1 || end <= start)
    return html

  return html.slice(start + startMarker.length, end)
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function renderRedactedTerminalFrame(rawAnsi: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, terminalPixelSize?: TerminalPixelSize): Promise<TerminalReplayFrame> {
  const normalizedTerminal = createTerminal(cols, rows)
  await writeTerminal(normalizedTerminal.term, rawAnsi)
  const text = redactSecrets(visibleTerminalText(normalizedTerminal.term))
  normalizedTerminal.term.dispose()

  const { serializeAddon, term } = createTerminal(cols, rows)
  await writeTerminal(term, text)
  const html = extractHtmlFragment(serializeAddon.serializeAsHTML({ includeGlobalBackground: true, scrollback: 0 }))
  const viewport = getReplayViewportSize(cols, rows, terminalPixelSize)
  term.dispose()
  return { height: viewport.height, html, text, width: viewport.width }
}

export async function renderRedactedTerminalText(rawAnsi: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  return (await renderRedactedTerminalFrame(rawAnsi, cols, rows)).text
}

async function patchRrwebGlobals<T>(window: Window, document: HappyDocument, task: () => T | Promise<T>) {
  const globalObject = globalThis as unknown as Record<string, unknown>
  const windowObject = window as unknown as Record<string, unknown>
  const patchedEntries: Array<[string, PropertyDescriptor | undefined]> = []
  const patchGlobal = (key: string, value: unknown) => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalObject, key)
    patchedEntries.push([key, previousDescriptor])
    Object.defineProperty(globalObject, key, {
      configurable: true,
      enumerable: previousDescriptor?.enumerable ?? true,
      value,
      writable: true,
    })
  }

  for (const [key, value] of Object.entries(windowObject)) {
    if (typeof value !== 'function' || !/^(HTML|SVG|CSS|Node|Document|Element|Text|CharacterData|Comment|ShadowRoot|MutationObserver|XML)/.test(key))
      continue

    patchGlobal(key, value)
  }

  for (const [key, value] of [
    ['document', document],
    ['window', window],
    ['navigator', window.navigator],
  ] as const)
    patchGlobal(key, value)

  try {
    return await task()
  }
  finally {
    for (const [key, previousDescriptor] of patchedEntries.reverse()) {
      if (previousDescriptor)
        Object.defineProperty(globalObject, key, previousDescriptor)
      else delete globalObject[key]
    }
  }
}

function findSerializedNodeId(node: serializedNodeWithId, tagName: string): number | undefined {
  const candidate = node as unknown as { childNodes?: serializedNodeWithId[], id?: number, tagName?: string }
  if (candidate.tagName === tagName && typeof candidate.id === 'number')
    return candidate.id

  for (const child of candidate.childNodes || []) {
    const id = findSerializedNodeId(child, tagName)
    if (id !== undefined)
      return id
  }

  return undefined
}
function findSerializedNodeIdByAttribute(node: serializedNodeWithId, attribute: string, value: string): number | undefined {
  const candidate = node as unknown as { attributes?: Record<string, unknown>, childNodes?: serializedNodeWithId[], id?: number }
  if (candidate.attributes?.[attribute] === value && typeof candidate.id === 'number')
    return candidate.id

  for (const child of candidate.childNodes || []) {
    const id = findSerializedNodeIdByAttribute(child, attribute, value)
    if (id !== undefined)
      return id
  }

  return undefined
}

function normalizeTerminalFrame(frame: TerminalReplayFrame | string): TerminalReplayFrame {
  if (typeof frame === 'string') {
    const viewport = getReplayViewportSize()
    return {
      height: viewport.height,
      html: `<pre>${escapeHtml(frame)}</pre>`,
      text: frame,
      width: viewport.width,
    }
  }
  return frame
}

function buildTerminalImageDataUrl(frame: TerminalReplayFrame) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">`,
    `<rect width="${frame.width}" height="${frame.height}" fill="#0d1117"/>`,
    `<foreignObject width="${frame.width}" height="${frame.height}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;padding:16px;background:#0d1117;color:#d6deeb;overflow:hidden;font:14px/${REPLAY_LINE_HEIGHT_PX}px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"><style>pre{margin:0;font:inherit}</style>`,
    frame.html,
    '</div></foreignObject></svg>',
  ].join('')

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

export async function createTerminalSnapshot(frameInput: TerminalReplayFrame | string, options: { ariaLabel?: string, currentUrl?: string } = {}): Promise<TerminalSnapshot> {
  const frame = normalizeTerminalFrame(frameInput)
  const window = new Window({ url: options.currentUrl || DEFAULT_REPLAY_CURRENT_URL })
  const document = window.document as HappyDocument

  document.documentElement.setAttribute('style', 'margin:0;min-height:100%;background:#0d1117;color:#d6deeb;')
  document.body.setAttribute('style', 'margin:0;min-height:100%;background:#0d1117;color:#d6deeb;')

  const terminal = document.createElement('div')
  terminal.setAttribute('aria-label', options.ariaLabel || 'Capgo terminal replay')
  terminal.setAttribute('aria-multiline', 'true')
  terminal.setAttribute('data-capgo-terminal', 'true')
  terminal.setAttribute('role', 'textbox')
  terminal.setAttribute('style', [
    'box-sizing:border-box',
    'width:100vw',
    'min-height:100vh',
    'margin:0',
    'padding:0',
    'background:#0d1117',
    'color:#d6deeb',
    'overflow:hidden',
  ].join(';'))

  const terminalImage = document.createElement('img')
  terminalImage.setAttribute('alt', frame.text)
  terminalImage.setAttribute('src', buildTerminalImageDataUrl(frame))
  terminalImage.setAttribute('style', [
    'display:block',
    'width:100%',
    'height:100vh',
    'object-fit:contain',
    'object-position:top left',
    'background:#0d1117',
  ].join(';'))
  terminal.appendChild(terminalImage)
  document.body.appendChild(terminal)

  const node = await patchRrwebGlobals(window, document, () => snapshot(document as unknown as Document, {
    blockClass: 'ph-no-capture',
    inlineStylesheet: false,
    maskTextClass: 'ph-mask',
    preserveWhiteSpace: true,
  }))

  if (!node)
    throw new Error('Could not serialize init replay snapshot')

  return {
    node,
    terminalNodeId: findSerializedNodeIdByAttribute(node, 'data-capgo-terminal', 'true') || findSerializedNodeId(node, 'div') || node.id,
  }
}

export async function createTerminalSnapshotNode(frame: TerminalReplayFrame | string): Promise<serializedNodeWithId> {
  return (await createTerminalSnapshot(frame)).node
}
export function createTerminalInteractionEvents(input: {
  terminalNodeId: number
  text: string
  timestamp: number
}): eventWithTime[] {
  const clickEventWithTime = {
    data: {
      id: input.terminalNodeId,
      pointerType: PointerTypes.Mouse,
      source: IncrementalSource.MouseInteraction,
      type: MouseInteractions.Click,
      x: 24,
      y: 24,
    },
    timestamp: input.timestamp,
    type: EventType.IncrementalSnapshot,
  } satisfies incrementalSnapshotEvent & { timestamp: number }

  const inputEventWithTime = {
    data: {
      id: input.terminalNodeId,
      isChecked: false,
      source: IncrementalSource.Input,
      text: input.text,
      userTriggered: true,
    },
    timestamp: input.timestamp + 1,
    type: EventType.IncrementalSnapshot,
  } satisfies incrementalSnapshotEvent & { timestamp: number }

  return [clickEventWithTime, inputEventWithTime]
}

export function buildInitReplayBody(input: {
  currentUrl?: string
  events: eventWithTime[]
  sessionId: string
  timestamp: string
  windowId: string
}): InitReplaySnapshotBody {
  return {
    event: '$snapshot',
    properties: {
      $current_url: input.currentUrl || DEFAULT_REPLAY_CURRENT_URL,
      $lib: '@capgo/cli',
      $lib_version: pack.version,
      $session_id: input.sessionId,
      $snapshot_bytes: new TextEncoder().encode(JSON.stringify(input.events)).length,
      $snapshot_data: input.events,
      $snapshot_source: 'web',
      $window_id: input.windowId,
    },
    timestamp: input.timestamp,
  }
}

const defaultReplayTransport: InitReplayTransport = async (url, body, apikey, signal) => {
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'capgkey': apikey,
      },
      method: 'POST',
      signal,
    })
    return response.ok
  }
  catch {
    return false
  }
}

class InitReplayRecorder implements InitReplayController {
  readonly sessionId: string
  private readonly pendingSends = new Set<Promise<boolean>>()
  private readonly restoreWrites: Array<() => void> = []
  private readonly serializeAddon: SerializeAddon
  private readonly term: Terminal
  private captureTimer: NodeJS.Timeout | undefined
  private disposed = false
  private hasSentMeta = false
  private metaGeneration = 0
  private lastSnapshotText = ''
  private pendingTerminalWrite = Promise.resolve()
  private resolvedTerminalPixelSize: TerminalPixelSize | undefined
  private terminalPixelSizeSource: Promise<TerminalPixelSize | undefined>
  private readonly windowId = `cli-${randomUUID()}`

  constructor(
    private readonly apikey: string,
    private readonly replayUrl: Promise<string | undefined>,
    private readonly abortReplayUrlLookup: (() => void) | undefined,
    private readonly transport: InitReplayTransport,
    private readonly currentUrl: string,
    private readonly ariaLabel: string | undefined,
    private readonly cols: number,
    private readonly rows: number,
    private readonly throttleMs: number,
    terminalPixelSize: Promise<TerminalPixelSize | undefined>,
    sessionPrefix: string,
  ) {
    this.terminalPixelSizeSource = terminalPixelSize
    this.sessionId = `${sessionPrefix}-${randomUUID()}`
    const { serializeAddon, term } = createTerminal(cols, rows)
    this.serializeAddon = serializeAddon
    this.term = term
    this.patchStream(stdout)
    this.patchStream(stderr)
    stdout.on('resize', this.resize)
    activeReplayFinish = () => this.finish()
    activeReplaySessionId = this.sessionId
  }
  async finish() {
    if (this.disposed)
      return

    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = undefined
    }

    // Apply any queued resize/clear before marking disposed so the forced final
    // snapshot is not captured at stale terminal dimensions.
    await this.pendingTerminalWrite

    this.disposed = true

    await this.captureFrame(true).catch(() => {})
    this.restore()

    const inFlight = [...this.pendingSends]
    if (inFlight.length > 0) {
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise(resolve => setTimeout(resolve, REPLAY_FLUSH_TIMEOUT_MS)),
      ])
    }
    this.term.dispose()
    if (activeReplaySessionId === this.sessionId) {
      activeReplayFinish = undefined
      activeReplaySessionId = undefined
    }
  }

  private patchStream(stream: CliStream) {
    const originalWrite = stream.write
    ;(stream as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
      this.recordOutput(args[0], typeof args[1] === 'string' ? args[1] as BufferEncoding : undefined)
      return (originalWrite as (...writeArgs: unknown[]) => boolean).apply(stream, args)
    }
    this.restoreWrites.push(() => {
      stream.write = originalWrite as StreamWrite
    })
  }

  private readonly resize = () => {
    if (this.disposed)
      return

    const cols = stdout.columns || this.cols
    const rows = stdout.rows || this.rows
    this.lastSnapshotText = ''
    this.hasSentMeta = false
    this.metaGeneration += 1
    this.resolvedTerminalPixelSize = undefined
    // Explicit pixel dimensions are stale after a resize; use the updated
    // columns/rows for viewport sizing instead.
    this.terminalPixelSizeSource = Promise.resolve(undefined)

    // Drain in-flight stdout writes before clearing — otherwise a stale chunk
    // from the old dimensions can land after clear and corrupt the next frame.
    this.pendingTerminalWrite = this.pendingTerminalWrite.then(async () => {
      if (this.disposed)
        return
      this.term.resize(cols, rows)
      this.term.clear()
    }).catch(() => {})

    this.scheduleCapture()
  }

  private recordOutput(chunk: unknown, encoding?: BufferEncoding) {
    if (this.disposed)
      return

    const text = chunkToString(chunk, encoding)
    if (!text)
      return

    this.pendingTerminalWrite = this.pendingTerminalWrite.then(() => writeTerminal(this.term, text)).catch(() => {})
    this.scheduleCapture()
  }

  private scheduleCapture() {
    if (this.captureTimer || this.disposed)
      return

    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined
      void this.captureFrame(false).catch(() => {})
    }, this.throttleMs)
    this.captureTimer.unref?.()
  }

  private async captureFrame(force: boolean) {
    if (this.pendingSends.size > 5 && !force)
      return
    await this.pendingTerminalWrite

    const rawAnsi = this.serializeAddon.serialize({ scrollback: 0 })
    const terminalPixelSize = await this.resolveTerminalPixelSize()
    const frame = await renderRedactedTerminalFrame(rawAnsi, stdout.columns || this.cols, stdout.rows || this.rows, terminalPixelSize)
    if (!frame.text || (!force && frame.text === this.lastSnapshotText))
      return

    this.lastSnapshotText = frame.text
    const timestamp = Date.now()
    const viewport = getReplayViewportSize(stdout.columns || this.cols, stdout.rows || this.rows, terminalPixelSize)
    const events: eventWithTime[] = []

    const metaGenerationAtCapture = this.metaGeneration
    const frameIncludesMeta = !this.hasSentMeta
    if (frameIncludesMeta) {
      const metaEventWithTime = {
        data: {
          height: viewport.height,
          href: this.currentUrl,
          width: viewport.width,
        },
        timestamp,
        type: EventType.Meta,
      } satisfies metaEvent & { timestamp: number }
      events.push(metaEventWithTime)
    }

    const terminalSnapshot = await createTerminalSnapshot(frame, { ariaLabel: this.ariaLabel, currentUrl: this.currentUrl })
    const snapshotEventWithTime = {
      data: {
        initialOffset: { left: 0, top: 0 },
        node: terminalSnapshot.node,
      },
      timestamp,
      type: EventType.FullSnapshot,
    } satisfies fullSnapshotEvent & { timestamp: number }
    events.push(snapshotEventWithTime)

    events.push(...createTerminalInteractionEvents({
      terminalNodeId: terminalSnapshot.terminalNodeId,
      text: frame.text,
      timestamp: timestamp + 1,
    }))

    const flushStartedAt = Date.now()
    const replayUrl = await resolveReplayUrlForFlush(this.replayUrl, REPLAY_FLUSH_TIMEOUT_MS, this.abortReplayUrlLookup)
    if (!replayUrl)
      return

    const remainingFlushMs = Math.max(1, REPLAY_FLUSH_TIMEOUT_MS - (Date.now() - flushStartedAt))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingFlushMs)
    timeout.unref?.()
    const body = buildInitReplayBody({
      currentUrl: this.currentUrl,
      events,
      sessionId: this.sessionId,
      timestamp: new Date(timestamp).toISOString(),
      windowId: this.windowId,
    })
    const pending = this.transport(replayUrl, body, this.apikey, controller.signal)
      .then((sent) => {
        if (sent && frameIncludesMeta && metaGenerationAtCapture === this.metaGeneration)
          this.hasSentMeta = true
        return sent
      })
      .catch(() => false)
      .finally(() => {
        clearTimeout(timeout)
        this.pendingSends.delete(pending)
      })
    this.pendingSends.add(pending)
  }

  private async resolveTerminalPixelSize() {
    if (this.resolvedTerminalPixelSize)
      return this.resolvedTerminalPixelSize

    this.resolvedTerminalPixelSize = await this.terminalPixelSizeSource.catch(() => undefined)
    return this.resolvedTerminalPixelSize
  }

  private restore() {
    stdout.off('resize', this.resize)
    while (this.restoreWrites.length > 0)
      this.restoreWrites.pop()?.()
  }
}

export function startInitReplay(options: StartInitReplayOptions = {}): InitReplayController | undefined {
  const apikey = options.apikey?.trim() || ''
  const customSupabaseReplayRequested = Boolean(options.supaHost?.trim() || options.supaAnon?.trim())
  const customSupabaseReplayUrl = options.supaHost?.trim() && options.supaAnon?.trim()
    ? resolveSupabaseReplayUrl(options.supaHost)
    : undefined
  const replayAnalyticsEnabled = options.analyticsEnabled !== false
    && (!customSupabaseReplayRequested || Boolean(options.replayUrl || customSupabaseReplayUrl))
  const shouldStart = shouldStartInitReplay({
    analyticsEnabled: replayAnalyticsEnabled,
    apikey,
    isCi: options.isCi ?? isCI,
    stdinIsTTY: Boolean(stdin.isTTY),
    stdoutIsTTY: Boolean(stdout.isTTY),
    telemetryDisabled: isCliTelemetryDisabled(),
  })

  if (!shouldStart)
    return undefined

  try {
    let abortReplayUrlLookup: (() => void) | undefined
    const replayUrl = options.replayUrl
      ? Promise.resolve(resolveCapgoReplayUrl(options.replayUrl))
      : customSupabaseReplayUrl
        ? Promise.resolve(customSupabaseReplayUrl)
        : (() => {
            const controller = new AbortController()
            abortReplayUrlLookup = () => controller.abort()
            return resolveConfiguredCapgoReplayUrl(controller.signal)
          })()
    const currentUrl = options.currentUrl?.trim() || DEFAULT_REPLAY_CURRENT_URL
    const sessionPrefix = options.sessionPrefix?.trim() || DEFAULT_REPLAY_SESSION_PREFIX
    const terminalPixelSize = Promise.resolve(options.terminalPixelSize)

    return new InitReplayRecorder(
      apikey,
      replayUrl,
      abortReplayUrlLookup,
      options.transport || defaultReplayTransport,
      currentUrl,
      options.ariaLabel,
      options.cols || stdout.columns || DEFAULT_COLS,
      options.rows || stdout.rows || DEFAULT_ROWS,
      options.throttleMs || REPLAY_FRAME_THROTTLE_MS,
      terminalPixelSize,
      sessionPrefix,
    )
  }
  catch {
    return undefined
  }
}

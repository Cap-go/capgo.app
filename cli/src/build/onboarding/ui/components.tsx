import type { FC } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import Spinner from 'ink-spinner'
// src/build/onboarding/ui/components.tsx
import React, { useEffect, useRef, useState } from 'react'
import stringWidth from 'string-width'
import { computeMaxScrollOffset, pickVisibleLines } from '../ai-fit.js'
import type { DiffLine } from '../diff-utils.js'

/**
 * Truncate a string to a maximum *terminal display width* (not codepoint
 * count). Emoji like 🔑 render as 2 columns; combining marks render as 0.
 * Array.from(s).length is wrong for either. Uses string-width for the
 * per-char width and leaves 1 column for the ellipsis.
 */
function truncateByDisplayWidth(s: string, maxWidth: number): string {
  if (stringWidth(s) <= maxWidth)
    return s
  const ellipsisWidth = 1
  let total = 0
  let out = ''
  for (const ch of s) {
    const w = stringWidth(ch)
    if (total + w > maxWidth - ellipsisWidth)
      break
    total += w
    out += ch
  }
  return `${out}…`
}

/** Pad a string with trailing spaces until its display width hits `width`. */
function padByDisplayWidth(s: string, width: number): string {
  const current = stringWidth(s)
  if (current >= width)
    return s
  return s + ' '.repeat(width - current)
}

export const Divider: FC<{ width?: number }> = ({ width = 60 }) => (
  <Text dimColor>{'─'.repeat(width)}</Text>
)

// Rendered row cost of each Header variant + the wizard's outer padding.
// The wizards use these against a live `measureElement` of the step body to
// decide — with no hardcoded height threshold — whether (a) the bordered box
// fits, (b) only the one-line header fits, or (c) not even the one-line
// header + content fits, in which case the resize prompt is shown.
//   box = double border (2) + paddingY (2) + text (1)
export const BOX_HEADER_ROWS = 5
export const COMPACT_HEADER_ROWS = 1
// The outer wizard <Box> uses padding={1} → one row top + one row bottom.
export const WIZARD_PADDING_ROWS = 2

// Frame-fit contract. Every rendered frame must fit within the 16-row floor so
// the wizard never surprises the user with a "terminal too small" block after a
// step that fit. A frame = adaptive header + body + padding; with the one-line
// compact header the body's row budget is 13 rows. Each step BODY component is
// unit-tested (see test/helpers/frame-fit.mjs, which derives the budget from
// COMPACT_HEADER_ROWS + WIZARD_PADDING_ROWS) to render within that budget at the
// reference widths, so a too-tall step can never silently regress.

/**
 * Minimal in-house Table component. Auto-sizes each column to the widest
 * value (header or any row cell) up to `maxColumnWidth`, truncates with
 * an ellipsis when a cell exceeds that width, and renders box-drawing
 * borders.
 *
 * Why inline instead of `ink-table`: the published `ink-table@3.1.0` is
 * CommonJS and modern `ink` (v5+) is ESM with top-level await, so bundling
 * fails. This component is the small subset of ink-table's API we need
 * (rows of plain string cells) without the compat headache.
 *
 * The `data` rows must share a single key order so columns line up — we
 * derive the column list from the first row's keys.
 *
 * `cellColor` runs per-cell and returns an Ink color name (or undefined
 * for default). Used by the available/unavailable-certs tables to colour
 * the status column green/red while keeping Name/Team dim.
 */
export interface TableProps {
  data: Record<string, string>[]
  /** Hard cap on column width before truncation. Default 50. */
  maxColumnWidth?: number
  /** Optional per-cell color function. */
  cellColor?: (column: string, value: string, rowIndex: number) => string | undefined
  /** Optional per-cell dim flag (defaults to false). */
  cellDim?: (column: string, value: string, rowIndex: number) => boolean
  /** Padding inside each cell (left/right). Default 1. */
  cellPadding?: number
}

export const Table: FC<TableProps> = ({ data, maxColumnWidth = 50, cellColor, cellDim, cellPadding = 1 }) => {
  if (data.length === 0)
    return null
  const columns = Object.keys(data[0])
  // Column widths are computed in TERMINAL DISPLAY WIDTH (not codepoint
  // count) — so a 🔑 emoji (2 cols wide) doesn't push the rendered row
  // past the border. See truncateByDisplayWidth comment for the gotcha.
  const widths: Record<string, number> = {}
  for (const col of columns) {
    let max = stringWidth(col)
    for (const row of data) {
      const v = row[col] ?? ''
      const w = stringWidth(v)
      if (w > max)
        max = w
    }
    widths[col] = Math.min(max, maxColumnWidth)
  }
  const pad = ' '.repeat(cellPadding)
  const borderRow = (left: string, mid: string, right: string, fill: string): string => {
    const segments = columns.map(c => fill.repeat(widths[c] + cellPadding * 2))
    return left + segments.join(mid) + right
  }
  const renderRow = (cells: { col: string, value: string, rowIndex?: number }[]): React.ReactNode => (
    <Text>
      │
      {cells.map((cell) => {
        const truncated = truncateByDisplayWidth(cell.value, widths[cell.col])
        const padded = padByDisplayWidth(truncated, widths[cell.col])
        const colorName = cellColor && cell.rowIndex !== undefined ? cellColor(cell.col, cell.value, cell.rowIndex) : undefined
        const dim = cellDim && cell.rowIndex !== undefined ? cellDim(cell.col, cell.value, cell.rowIndex) : false
        return (
          <React.Fragment key={cell.col}>
            {pad}
            <Text color={colorName as any} dimColor={dim}>{padded}</Text>
            {pad}
            │
          </React.Fragment>
        )
      })}
    </Text>
  )
  return (
    <Box flexDirection="column">
      <Text dimColor>{borderRow('┌', '┬', '┐', '─')}</Text>
      {renderRow(columns.map(c => ({ col: c, value: c })))}
      <Text dimColor>{borderRow('├', '┼', '┤', '─')}</Text>
      {data.map((row, i) => (
        <React.Fragment key={`row-${i}`}>
          {renderRow(columns.map(c => ({ col: c, value: row[c] ?? '', rowIndex: i })))}
        </React.Fragment>
      ))}
      <Text dimColor>{borderRow('└', '┴', '┘', '─')}</Text>
    </Box>
  )
}

export const SpinnerLine: FC<{ text: string }> = ({ text }) => (
  <Box>
    <Box marginRight={1}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    </Box>
    <Text>{text}</Text>
  </Box>
)

export const SuccessLine: FC<{ text: string, detail?: string }> = ({ text, detail }) => (
  <Box>
    <Text color="green">✔ </Text>
    <Text>{text}</Text>
    {detail && (
      <Text dimColor>
        {' '}
        ·
        {detail}
      </Text>
    )}
  </Box>
)

export const ErrorLine: FC<{ text: string }> = ({ text }) => (
  <Box>
    <Text color="red">✖ </Text>
    <Text color="red">{text}</Text>
  </Box>
)

// Non-success outcomes of a Capgo AI analysis request. `error` is a genuine
// failure (network/backend); `already_analyzed` and `too_big` are blocking
// "can't proceed" states the backend reports deliberately.
export type AiResultKind = 'already_analyzed' | 'too_big' | 'error'

// Renders a non-success AI-analysis outcome as a prominent, coloured banner so
// the user reads it as a distinct blocking state instead of mistaking it for
// part of the neutral analysis text (these used to render as a plain <Text>
// line and blended in — users couldn't tell the request had been rejected).
// `error` is red (✖); `already_analyzed` / `too_big` are yellow (⚠) since
// they're expected, non-crash outcomes.
//
// Adaptive: the comfortable form (default) is a bordered box — the original,
// most-prominent design. The `dense` form drops the box (saving ~2 rows) for
// terminals too short to fit the boxed version within the 16-row contract; the
// parent sets `dense` only when the measured comfortable frame won't fit.
export const AiResultBanner: FC<{ kind: AiResultKind, message: string, dense?: boolean }> = ({ kind, message, dense = false }) => {
  const isError = kind === 'error'
  const color = isError ? 'red' : 'yellow'
  const icon = isError ? '✖' : '⚠'
  const label = kind === 'error'
    ? 'Analysis failed'
    : kind === 'too_big'
      ? 'Build log too large'
      : 'Already analyzed'
  const inner = (
    <>
      <Text color={color} bold>{`${icon}  ${label}`}</Text>
      <Text color={color}>{message}</Text>
    </>
  )
  if (dense) {
    return <Box flexDirection="column">{inner}</Box>
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {inner}
    </Box>
  )
}

/**
 * Custom TextInput that filters out specific characters (e.g. '=').
 * @inkjs/ui's TextInput is uncontrolled and can't filter keystrokes,
 * so we build a minimal one with Ink's useInput.
 */
export const FilteredTextInput: FC<{
  placeholder?: string
  /**
   * Blacklist of characters to strip from input. Each char in this string is
   * removed from the buffer after every keystroke. Used for casual filtering
   * (e.g. stripping `=` from env-var values).
   */
  filter?: string
  /**
   * Whitelist regex matched per-character. Anything not matching is dropped.
   * Takes precedence over `filter` when both are set. Used when the field has
   * a tight format (Apple Key ID is exactly 10 alphanumeric chars; Issuer ID
   * is a UUID; etc.) so users can't even type invalid characters.
   */
  allowedPattern?: RegExp
  /**
   * Hard cap on input length. Extra characters past the cap are dropped
   * silently (paste-safe). Pair with `allowedPattern` for known-format fields
   * — e.g. Apple Key ID has `maxLength=10` so a paste of "Key ID: KDTXMK292V"
   * truncates to the first 10 valid chars after filtering.
   */
  maxLength?: number
  /**
   * Post-filter transform applied to the entire buffer after each keystroke.
   * Most common use: `(s) => s.toUpperCase()` for fields that are case-
   * insensitive but conventionally uppercase. Runs after filter + maxLength.
   */
  transform?: (value: string) => string
  mask?: boolean
  /**
   * Pre-fills the input. Used when the user is editing an already-entered
   * value (e.g. fixing a typo in their ASC Key ID / Issuer ID after a
   * verifying-key failure) so they don't have to retype everything.
   * Backspace works normally to delete from the pre-filled value.
   */
  initialValue?: string
  onSubmit: (value: string) => void
}> = ({ placeholder = '', filter = '=', allowedPattern, maxLength, transform, mask = false, initialValue = '', onSubmit }) => {
  const [value, setValue] = useState(() => applyConstraints(initialValue, { filter, allowedPattern, maxLength, transform }))
  // PTY harnesses often paste a full path then Enter in one burst; Ink can emit
  // multiple parsed input events before React evaluates queued setState updaters.
  // Keep the live buffer in a ref updated synchronously before setValue.
  const valueRef = useRef(value)

  useInput((input, key) => {
    if (key.return) {
      onSubmit(valueRef.current)
      return
    }
    if (key.backspace || key.delete) {
      const next = valueRef.current.slice(0, -1)
      valueRef.current = next
      setValue(next)
      return
    }
    // Ignore control characters, arrows, etc.
    if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return
    }
    // Append input then apply the full constraint pipeline (paste-safe).
    if (input) {
      const next = applyConstraints(valueRef.current + input, { filter, allowedPattern, maxLength, transform })
      valueRef.current = next
      setValue(next)
    }
  })

  const display = mask ? '•'.repeat(value.length) : value
  const showCounter = maxLength !== undefined && !mask
  return (
    <Box>
      <Text color="cyan">❯ </Text>
      {value
        ? <Text>{display}</Text>
        : <Text dimColor>{placeholder}</Text>}
      <Text color="white">█</Text>
      {showCounter && (
        <Text dimColor>
          {'  '}
          {value.length}
          /
          {maxLength}
        </Text>
      )}
    </Box>
  )
}

/**
 * Apply the FilteredTextInput constraint pipeline in a single deterministic
 * pass: blacklist filter → allowedPattern whitelist → maxLength truncate →
 * transform. Pulled out so the initial-value prefill goes through the same
 * pipeline as user keystrokes (an initialValue with invalid chars would
 * otherwise appear briefly before the user typed anything).
 */
function applyConstraints(
  raw: string,
  opts: { filter: string, allowedPattern?: RegExp, maxLength?: number, transform?: (value: string) => string },
): string {
  let out = raw
  if (opts.filter) {
    const escape = (c: string) => c.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')
    out = out.replace(new RegExp(`[${escape(opts.filter)}]`, 'g'), '')
  }
  if (opts.allowedPattern) {
    // Match each character against the per-character pattern. If the regex
    // is global or anchored we still treat it as a single-char test.
    const perChar = new RegExp(opts.allowedPattern.source, opts.allowedPattern.flags.replace(/g/g, ''))
    out = Array.from(out).filter(ch => perChar.test(ch)).join('')
  }
  if (opts.maxLength !== undefined && out.length > opts.maxLength)
    out = out.slice(0, opts.maxLength)
  if (opts.transform)
    out = opts.transform(out)
  return out
}

// `compact` collapses the banner to a single borderless line. Callers pass
// it when the terminal is too short (< HEADER_BOX_MIN_ROWS) to spend ~5 rows
// on the bordered box — the branding stays, the vertical cost drops to 1 row.
// The banner is ALWAYS the full boxed form now. The startup size gate
// (min-size-gate.tsx) guarantees enough rows for it, so there's no reason to
// degrade to the one-line variant on short terminals. `compact` is accepted but
// ignored so existing call sites keep compiling; the prop + its arguments are
// removed in the dense-cleanup follow-up.
export const Header: FC<{ compact?: boolean }> = () => {
  return (
    <Box
      borderStyle="double"
      borderColor="cyan"
      width={44}
      paddingX={4}
      paddingY={1}
      alignSelf="center"
    >
      <Text bold color="cyan">
        🚀  Capgo Cloud Build · Onboarding
      </Text>
    </Box>
  )
}

/**
 * Scrollable, fullscreen viewer for the AI build-analysis markdown when it
 * is taller than the user's terminal viewport. Mirrors the shape of the
 * workflow-file diff viewer on main, but for pre-rendered ANSI lines (no
 * `add`/`del` colouring — the markdown renderer already styled them).
 *
 * Keybindings:
 *   ↑/k        scroll one line up
 *   ↓/j        scroll one line down
 *   PgUp/u     jump up one viewport
 *   PgDn/d/␣   jump down one viewport
 *   Home/g     jump to top
 *   End/G      jump to bottom
 *   Esc/Enter  dismiss the viewer (returns control to the parent step)
 */
export const FullscreenAiViewer: FC<{
  title: string
  subtitle?: string
  lines: string[]
  terminalRows: number
  onExit: () => void
  // Override the bottom exit line. Defaults to the AI-analysis wording; pass this
  // when reusing the viewer elsewhere (e.g. the support log viewer) so the footer
  // doesn't talk about a "retry/skip prompt" that doesn't exist there.
  exitHint?: string
}> = ({ title, subtitle, lines, terminalRows, onExit, exitHint }) => {
  // Track terminal dimensions in state so the component re-renders on resize.
  // Without this, the viewport was computed at mount and the body could
  // overflow the live screen if the user enlarged or shrank the terminal —
  // forcing the user to scroll their terminal emulator to see content the
  // viewer should have paginated.
  const { stdout } = useStdout()
  // Read the live size DIRECTLY each render + force a re-render on resize (same
  // reasoning as FullscreenBuildOutput / the shell's useTerminalSize): holding it
  // in state lags one frame, so a resize briefly renders at the old size and
  // leaves ghost rows on a shrink.
  const [, forceResize] = useState(0)
  useEffect(() => {
    if (!stdout)
      return
    const onResize = (): void => forceResize(n => n + 1)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  const dims = { rows: stdout?.rows ?? terminalRows, cols: stdout?.columns ?? 80 }

  // The viewer is a fullscreen takeover: the parent renders it as an early
  // return that fills the whole terminal (no outer Header, no wizard padding),
  // so its available height is the full terminal. Its own chrome is exactly 6
  // rows — title + optional subtitle + two dividers + position line + exit hint
  // — and the rest is the scrollable viewport. (Previously this reserved 10 to
  // stay short enough not to trip the parent's body-measurement; now the early
  // return bypasses that, so we reserve only the real chrome and a flex spacer
  // fills any remainder — no dead space, and more lines visible per screen.)
  const VIEWER_CHROME_ROWS = 6
  const viewportRows = Math.max(1, dims.rows - VIEWER_CHROME_ROWS)
  const total = lines.length
  // Wrap-aware bound: maximum offset that still places the last logical line
  // inside the viewport. Without per-line wrap accounting the user could
  // scroll past the end on narrow terminals.
  const maxScrollOffset = computeMaxScrollOffset(lines, viewportRows, dims.cols)
  const [scrollOffset, setScrollOffset] = useState(0)

  // Clamp the scroll if the viewport grew past the bottom (e.g. terminal
  // resized larger after the user scrolled to the bottom).
  useEffect(() => {
    setScrollOffset(prev => Math.min(prev, maxScrollOffset))
  }, [maxScrollOffset])

  useInput((input, key) => {
    if (key.escape || key.return) {
      onExit()
      return
    }
    if (key.downArrow || input === 'j') {
      setScrollOffset(prev => Math.min(prev + 1, maxScrollOffset))
      return
    }
    if (key.upArrow || input === 'k') {
      setScrollOffset(prev => Math.max(prev - 1, 0))
      return
    }
    if (key.pageDown || input === 'd' || input === ' ') {
      setScrollOffset(prev => Math.min(prev + viewportRows, maxScrollOffset))
      return
    }
    if (key.pageUp || input === 'u') {
      setScrollOffset(prev => Math.max(prev - viewportRows, 0))
      return
    }
    if (input === 'g') {
      setScrollOffset(0)
      return
    }
    if (input === 'G') {
      setScrollOffset(maxScrollOffset)
    }
  })

  // Wrap-aware visible slice. `pickVisibleLines` stops adding logical lines
  // once their cumulative wrapped row count would overflow `viewportRows`,
  // so we never render past the bottom of the live terminal.
  const visibleLines = pickVisibleLines(lines, scrollOffset, viewportRows, dims.cols)
  const firstVisibleLine = total === 0 ? 0 : scrollOffset + 1
  const lastVisibleLine = Math.min(total, scrollOffset + visibleLines.length)
  const atBottom = scrollOffset >= maxScrollOffset
  // Divider widths scale to the terminal so the cosmetic border doesn't
  // wrap on narrow terminals (which would silently eat a viewport row).
  const dividerWidth = Math.max(10, Math.min(60, dims.cols - 1))

  // Suppress every scroll-related hint when the analysis fits the viewport
  // outright. The conservative `isAiAnalysisTooTall` estimator in the parent
  // sometimes routes us here even though `pickVisibleLines` ends up showing
  // every logical line — telling the user to "↑/↓ to scroll" when scrolling
  // is a no-op is just noise. The subtitle is also suppressed in that case
  // because its only job is to advertise "this is scrollable".
  const hasMoreToScroll = maxScrollOffset > 0

  return (
    // minHeight fills the whole terminal and the flexGrow spacer below pushes
    // the bottom divider + hints to the very bottom — so the frame height is
    // constant across scroll positions AND there's no dead space, regardless
    // of how many lines are currently visible.
    <Box flexDirection="column" minHeight={dims.rows}>
      <Text bold color="cyan">{title}</Text>
      {subtitle && hasMoreToScroll && <Text dimColor>{subtitle}</Text>}
      <Text color="cyan">{'─'.repeat(dividerWidth)}</Text>
      {/* Fixed-height, clipped content area. `pickVisibleLines` packs it full
          (including a line that crosses the bottom), so when more lines remain
          the viewport is full of text — no empty gap — and the overflowing
          last line is clipped here rather than pushing the footer off-screen.
          A fixed `height` (not flexGrow, which has no max and so won't clip)
          is what makes overflow:hidden actually trim the excess. */}
      <Box flexDirection="column" height={viewportRows} overflow="hidden">
        {visibleLines.map((line, index) => (
          // Render empty lines as a single space so they occupy ONE row —
          // matching renderedRowsForLine's floor of 1. Ink collapses an empty
          // <Text> to zero rows, but pickVisibleLines counts each blank as 1;
          // that mismatch made the packer stop early and the fixed-height box
          // pad the shortfall as blank rows at the bottom (the "gap"), while
          // excluding real content below. Keeping blanks 1 row aligns the two.
          <Text key={`ai-line-${scrollOffset + index}`}>{line === '' ? ' ' : line}</Text>
        ))}
      </Box>
      <Text color="cyan">{'─'.repeat(dividerWidth)}</Text>
      <Text dimColor>
        {hasMoreToScroll
          ? `Showing ${firstVisibleLine}-${lastVisibleLine} of ${total} lines. ↑/↓ or PgUp/PgDn to scroll.`
          : `Showing all ${total} lines.`}
      </Text>
      <Text color="yellow" bold>
        {exitHint
          ?? (hasMoreToScroll && !atBottom
            ? 'Press Esc or Enter when done to continue.'
            : 'Press Esc or Enter to continue to the retry/skip prompt.')}
      </Text>
    </Box>
  )
}

// Pure predicate for the build-complete success screen. The wizard deliberately
// does NOT auto-exit there (on the alt-screen, exit() wipes the final frame
// instantly); instead it waits for the user to dismiss with Enter / Esc / q.
// Extracted as a pure function so the exit behavior is unit-testable without
// rendering the whole app (same rationale as buildScrollAction).
export function isBuildCompleteDismissKey(
  input: string,
  key: { return?: boolean, escape?: boolean },
): boolean {
  return Boolean(key.return || key.escape || input === 'q')
}

// Pure keypress → scroll/follow transition for the streaming build viewer
// (extracted so the scroll logic is unit-testable without rendering, like
// platformKeyAction). Returns the next { scrollOffset, follow } or null for an
// unhandled key. Scrolling down to the bottom (re)enables follow; any upward
// move pauses it; G jumps to the bottom and follows, g jumps to the top.
export interface BuildScrollState { scrollOffset: number, follow: boolean }
export function buildScrollAction(
  input: string,
  key: { upArrow?: boolean, downArrow?: boolean, pageUp?: boolean, pageDown?: boolean },
  state: { scrollOffset: number, maxScrollOffset: number, viewportRows: number },
): BuildScrollState | null {
  const { scrollOffset, maxScrollOffset, viewportRows } = state
  if (key.downArrow || input === 'j') {
    const next = Math.min(scrollOffset + 1, maxScrollOffset)
    return { scrollOffset: next, follow: next >= maxScrollOffset }
  }
  if (key.upArrow || input === 'k')
    return { scrollOffset: Math.max(scrollOffset - 1, 0), follow: false }
  if (key.pageDown || input === 'd' || input === ' ') {
    const next = Math.min(scrollOffset + viewportRows, maxScrollOffset)
    return { scrollOffset: next, follow: next >= maxScrollOffset }
  }
  if (key.pageUp || input === 'u')
    return { scrollOffset: Math.max(scrollOffset - viewportRows, 0), follow: false }
  if (input === 'g')
    return { scrollOffset: 0, follow: false }
  if (input === 'G')
    return { scrollOffset: maxScrollOffset, follow: true }
  return null
}

// Compact elapsed-time label for the build timer: "42s" under a minute,
// "1m 05s" above (seconds zero-padded so the width is stable). Negative inputs
// clamp to 0s.
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

// Streaming build-output viewer — a fullscreen takeover (like FullscreenAiViewer)
// the parent renders as an EARLY RETURN so it owns the whole terminal and
// BYPASSES the wizard's body-measurement / dense / too-small logic. The
// `requesting-build` step's output grows unbounded; rendered inside the measured
// body it inflated bodyHeight and tripped the "terminal too small" gate. Here it
// can't: the output lives in a fixed-height viewport that always fits the live
// screen, exactly as the AI analysis viewer paginates tall content.
//
// Follow mode (like `less +F`): by default the viewport tails the stream,
// sticking to the bottom as new lines arrive. Scrolling up (↑/k, PgUp/u) PAUSES
// the tail so earlier output can be read; scrolling back to the bottom (↓/G)
// resumes following. Live chrome is two rows (a divider + status line); the
// read-only failed-build view adds one exit-hint row. The rest is the clipped
// viewport, which resizes with the terminal.
export const FullscreenBuildOutput: FC<{
  title: string
  lines: string[]
  terminalRows: number
  onExit?: () => void
}> = ({ title, lines, terminalRows, onExit }) => {
  const { stdout } = useStdout()
  // Read the live terminal size DIRECTLY each render — Node updates
  // stdout.rows/columns BEFORE emitting 'resize' and Ink re-renders on resize, so
  // a direct read is already current. The listener only forces a re-render.
  // Holding the size in state (setDims on resize) lags one frame: the resize
  // re-render runs with the STALE size, so minHeight is briefly the OLD height —
  // and on a shrink that over-tall frame overflows the smaller terminal, leaving
  // ghost rows until the next frame corrects (the "resize shifts things around"
  // glitch). Same pattern as the shell's useTerminalSize.
  const [, forceResize] = useState(0)
  useEffect(() => {
    if (!stdout)
      return
    const onResize = (): void => forceResize(n => n + 1)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  const dims = { rows: stdout?.rows ?? terminalRows, cols: stdout?.columns ?? 80 }

  // Live elapsed-time clock so the user sees how long the build has been
  // running. Counts from mount (the start of the requesting-build phase) and
  // resets if the step remounts on a retry. Ticks independently of follow/scroll.
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = formatElapsed(now - startedAt)

  const CHROME_ROWS = onExit ? 3 : 2 // bottom divider + status line + optional exit line
  const viewportRows = Math.max(1, dims.rows - CHROME_ROWS)
  // Each log line renders as exactly ONE row (truncated to the terminal width in
  // the viewport below), so the viewport is a plain 1:1 slice — NOT the
  // wrap-aware packing the AI viewer needs. We deliberately do not wrap: an
  // un-truncated line — e.g. a multi-KB base64 provisioning/key blob streamed in
  // the build env — wraps to dozens of rows, which (a) lets one line dominate or
  // overflow the viewport, and (b) desyncs Ink's per-line row accounting from
  // what the terminal actually draws, leaving stale "dead space" rows that don't
  // repaint on stream/scroll/resize. One row per line keeps the frame exactly
  // dims.rows tall so Ink always takes its full clear-screen redraw path. A
  // tail-follow build log is read vertically, not horizontally, so truncating
  // over-long lines is the right model (the full log is also captured to disk).
  const maxScrollOffset = Math.max(0, lines.length - viewportRows)

  // `follow` is the SINGLE source of truth for the tail state — never a
  // comparison of scrollOffset vs maxScrollOffset. When following, the offset is
  // DERIVED as the live maxScrollOffset every render (no chasing useEffect), so a
  // newly streamed line can't open a one-frame window where a lagging scrollOffset
  // reads as "scrolled up" and flashes the paused hint / flips the alignment.
  // `pausedOffset` only matters while paused (clamped so a resize-larger can't
  // strand us past the end).
  const [follow, setFollow] = useState(true)
  const [pausedOffset, setPausedOffset] = useState(0)
  const scrollOffset = follow ? maxScrollOffset : Math.min(pausedOffset, maxScrollOffset)

  useInput((input, key) => {
    if (onExit && isBuildCompleteDismissKey(input, key)) {
      onExit()
      return
    }
    const action = buildScrollAction(input, key, { scrollOffset, maxScrollOffset, viewportRows })
    if (!action)
      return
    setFollow(action.follow)
    setPausedOffset(action.scrollOffset)
  })

  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportRows)
  const dividerWidth = Math.max(10, Math.min(60, dims.cols - 1))
  const hint = maxScrollOffset === 0
    ? ''
    : follow
      ? '  ·  ↑ scroll back'
      : '  ·  paused — ↓/G to resume'

  return (
    <Box flexDirection="column" minHeight={dims.rows}>
      {/* Fixed-height clipped viewport. At the bottom (following) the lines are
          bottom-aligned — newest just above the status bar, like a terminal
          tail; scrolled up they read top-down from the scroll position. Either
          way a single over-long wrapped line is clipped rather than pushing the
          footer off-screen. */}
      <Box flexDirection="column" height={viewportRows} justifyContent={follow ? 'flex-end' : 'flex-start'} overflow="hidden">
        {visibleLines.map((line, index) => {
          const isSuccess = line.startsWith('✔')
          const isError = line.startsWith('✖') || line.startsWith('❌')
          const isWarn = line.startsWith('⚠')
          const isBold = line.startsWith('✔ Build') || line.startsWith('✔ Created') || line.startsWith('Uploading:')
          const color = isSuccess ? 'green' : isError ? 'red' : isWarn ? 'yellow' : undefined
          return (
            <Text key={`build-${scrollOffset + index}`} color={color} bold={isBold} dimColor={!color && !isBold} wrap="truncate-end">
              {line === '' ? ' ' : line}
            </Text>
          )
        })}
      </Box>
      <Text color="cyan">{'─'.repeat(dividerWidth)}</Text>
      {onExit
        ? (
            <>
              <Text wrap="truncate-end"><Text color="red" bold>{`✖ ${title}`}</Text><Text dimColor>{`  ·  ${lines.length} lines${hint}`}</Text></Text>
              <Text color="yellow" bold>Press Esc or Enter to go back.</Text>
            </>
          )
        : (
            <Box>
              <SpinnerLine text={title} />
              <Text dimColor wrap="truncate-end">{`  ·  ${elapsed}  (${lines.length} lines)${hint}`}</Text>
            </Box>
          )}
    </Box>
  )
}

/**
 * Minimal bordered table component for the confirm-secrets-push step.
 *
 * Rolled in-house instead of pulling `ink-table` because that package is
 * CommonJS-only and Ink 5 uses top-level await — bun can't bundle the combo.
 * Replicates the visual style (box-drawing borders, aligned columns) with
 * ~50 lines of Ink primitives, lets us color the Status column per-row, and
 * leaves nothing to maintain outside this repo.
 */
export interface SecretRow {
  name: string
  status: 'NEW' | 'REPLACE'
}

/**
 * Diff viewer building blocks for the workflow-file preview flow.
 *
 * When the proposed content is byte-identical to what's on disk we skip the
 * line-by-line dump entirely and show a short "matches — no diff" banner —
 * dumping 70 lines of `[eq]` content would only add noise.
 */
function getDiffCounts(lines: DiffLine[]): { addCount: number, delCount: number, total: number } {
  return {
    addCount: lines.filter(l => l.kind === 'add').length,
    delCount: lines.filter(l => l.kind === 'del').length,
    total: lines.length,
  }
}

export const DiffSummary: FC<{ title: string, subtitle?: string, lines: DiffLine[] }> = ({ title, subtitle, lines }) => {
  const { addCount, delCount, total } = getDiffCounts(lines)
  const allEqual = total > 0 && lines.every(l => l.kind === 'eq')

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">{title}</Text>
      {subtitle && <Text dimColor>{subtitle}</Text>}
      <Text color="cyan">{'─'.repeat(60)}</Text>
      {allEqual
        ? (
            <Text color="green" bold>
              ✓ File on disk already matches the proposed content —
              {' '}
              {total}
              {' '}
              identical line
              {total === 1 ? '' : 's'}
              , no diff to show.
            </Text>
          )
        : (
            <Text dimColor>
              {'Summary:  '}
              <Text color="green">{`+${addCount} added`}</Text>
              {'   '}
              <Text color="red">{`-${delCount} removed`}</Text>
              {'   '}
              <Text>{`${total} line${total === 1 ? '' : 's'} total`}</Text>
            </Text>
          )}
    </Box>
  )
}

export const FullscreenDiffViewer: FC<{
  title: string
  subtitle?: string
  lines: DiffLine[]
  terminalRows: number
  onExit: () => void
}> = ({ title, subtitle, lines, terminalRows, onExit }) => {
  // Read the live terminal size each render + re-render on resize (same as
  // FullscreenAiViewer). The parent renders this as a fullscreen early-return
  // takeover, so it owns the whole terminal: reserve only the real chrome
  // (7 rows — title + subtitle + two dividers + summary + position + exit hint)
  // and let the viewport fill the rest. Previously this reserved 12 AND rendered
  // inside the wizard Box, so a big top gap + a short viewport wasted the screen.
  const { stdout } = useStdout()
  const [, forceResize] = useState(0)
  useEffect(() => {
    if (!stdout)
      return
    const onResize = (): void => forceResize(n => n + 1)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  const dims = { rows: stdout?.rows ?? terminalRows, cols: stdout?.columns ?? 80 }
  const dividerWidth = Math.max(10, Math.min(60, dims.cols - 1))
  const DIFF_CHROME_ROWS = 7
  const viewportRows = Math.max(1, dims.rows - DIFF_CHROME_ROWS)
  const [scrollOffset, setScrollOffset] = useState(0)
  const { addCount, delCount, total } = getDiffCounts(lines)
  const maxScrollOffset = Math.max(0, lines.length - viewportRows)

  useEffect(() => {
    setScrollOffset(prev => Math.min(prev, maxScrollOffset))
  }, [maxScrollOffset])

  useInput((input, key) => {
    if (key.escape || key.return) {
      onExit()
      return
    }
    if (key.downArrow || input === 'j') {
      setScrollOffset(prev => Math.min(prev + 1, maxScrollOffset))
      return
    }
    if (key.upArrow || input === 'k') {
      setScrollOffset(prev => Math.max(prev - 1, 0))
      return
    }
    if (key.pageDown || input === 'd') {
      setScrollOffset(prev => Math.min(prev + viewportRows, maxScrollOffset))
      return
    }
    if (key.pageUp || input === 'u') {
      setScrollOffset(prev => Math.max(prev - viewportRows, 0))
    }
  })

  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportRows)
  const firstVisibleLine = total === 0 ? 0 : scrollOffset + 1
  const lastVisibleLine = Math.min(total, scrollOffset + visibleLines.length)
  const lineNumberWidth = String(Math.max(total, 1)).length

  return (
    // minHeight fills the whole terminal; the fixed-height content box below
    // clips overflow so the footer stays pinned at the bottom and the frame
    // height is constant — no dead space regardless of scroll position.
    <Box flexDirection="column" minHeight={dims.rows}>
      <Text bold color="cyan" wrap="truncate-end">{title}</Text>
      {subtitle && <Text dimColor wrap="truncate-end">{subtitle}</Text>}
      <Text color="cyan">{'─'.repeat(dividerWidth)}</Text>
      <Text dimColor>
        {'Summary:  '}
        <Text color="green">{`+${addCount} added`}</Text>
        {'   '}
        <Text color="red">{`-${delCount} removed`}</Text>
      </Text>
      <Box flexDirection="column" height={viewportRows} overflow="hidden">
        {visibleLines.map((line, index) => {
          const lineNumber = String(scrollOffset + index + 1).padStart(lineNumberWidth, ' ')
          if (line.kind === 'add') {
            return (
              <Text key={`line-${scrollOffset + index}`} color="green" wrap="truncate-end">
                {`${lineNumber} + `}
                {line.text}
              </Text>
            )
          }
          if (line.kind === 'del') {
            return (
              <Text key={`line-${scrollOffset + index}`} color="red" wrap="truncate-end">
                {`${lineNumber} - `}
                {line.text}
              </Text>
            )
          }
          return (
            <Text key={`line-${scrollOffset + index}`} dimColor wrap="truncate-end">
              {`${lineNumber}   `}
              {line.text}
            </Text>
          )
        })}
      </Box>
      <Text color="cyan">{'─'.repeat(dividerWidth)}</Text>
      <Text dimColor>
        {`Showing ${firstVisibleLine}-${lastVisibleLine} of ${total} lines. Use ↑/↓ or k/j to scroll.`}
      </Text>
      <Text color="yellow" bold>Press Escape or Enter to exit diff viewer</Text>
    </Box>
  )
}

/**
 * Render the secrets table inline. Keep this dynamic so the onboarding header
 * and prompt stay in one live Ink frame.
 */
export const SecretsTable: FC<{ rows: SecretRow[] }> = ({ rows }) => {
  const nameHeader = 'Secret name'
  const statusHeader = 'Status'
  const nameWidth = Math.max(nameHeader.length, ...rows.map(r => r.name.length))
  const statusWidth = Math.max(statusHeader.length, ...rows.map(r => r.status.length))

  const top = `┌─${'─'.repeat(nameWidth)}─┬─${'─'.repeat(statusWidth)}─┐`
  const sep = `├─${'─'.repeat(nameWidth)}─┼─${'─'.repeat(statusWidth)}─┤`
  const bot = `└─${'─'.repeat(nameWidth)}─┴─${'─'.repeat(statusWidth)}─┘`

  return (
    <Box flexDirection="column">
      <Text dimColor>{top}</Text>
      <Box>
        <Text dimColor>│ </Text>
        <Text bold>{nameHeader.padEnd(nameWidth, ' ')}</Text>
        <Text dimColor> │ </Text>
        <Text bold>{statusHeader.padEnd(statusWidth, ' ')}</Text>
        <Text dimColor> │</Text>
      </Box>
      <Text dimColor>{sep}</Text>
      {rows.map(row => (
        <Box key={row.name}>
          <Text dimColor>│ </Text>
          <Text>{row.name.padEnd(nameWidth, ' ')}</Text>
          <Text dimColor> │ </Text>
          <Text color={row.status === 'REPLACE' ? 'yellow' : 'green'}>
            {row.status.padEnd(statusWidth, ' ')}
          </Text>
          <Text dimColor> │</Text>
        </Box>
      ))}
      <Text dimColor>{bot}</Text>
    </Box>
  )
}

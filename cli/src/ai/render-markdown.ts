/**
 * Tiny terminal renderer for the subset of markdown the AI is asked to emit:
 * `###`/`####` headers, fenced code blocks, **bold**, *italic*, `inline code`,
 * numbered lists (`1.`), bullet lists (`-` / `*`), and plain paragraphs.
 *
 * No external dep — uses raw ANSI escape sequences. Falls back to the input
 * unchanged when stdout is not a TTY, so output remains grep-able and pipeable.
 *
 * Foreground colors only, deliberately: terminal themes vary (dark, light,
 * blue…), so background "chips" can't look right everywhere.
 *
 * The renderer is line-based with a single piece of cross-line state
 * (`inCodeBlock`), exposed via `renderMarkdownLine` + `MarkdownRenderState` so
 * the streaming path (see stream-markdown.ts) can render incrementally with
 * byte-identical output to the buffered `renderMarkdown`.
 */
import process from 'node:process'

const ANSI = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  italic: '\x1B[3m',
  green: '\x1B[32m',
  cyan: '\x1B[36m',
  yellow: '\x1B[33m',
  gray: '\x1B[90m',
}

function stylize(open: string, text: string): string {
  return `${open}${text}${ANSI.reset}`
}

function renderInline(line: string): string {
  // Order matters: handle code spans first so we don't bold/italic content inside backticks.
  return line
    // `inline code` -> dim cyan
    .replace(/`([^`]+)`/g, (_, code: string) => stylize(`${ANSI.cyan}${ANSI.dim}`, code))
    // **bold** -> bold (after code so the ** in code isn't matched)
    .replace(/\*\*([^*]+)\*\*/g, (_, b: string) => stylize(ANSI.bold, b))
    // *italic* -> italic. Negative-lookahead/behind avoid ** false-matches and
    // bare * in log content.
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, (_, prefix: string, i: string) => `${prefix}${stylize(ANSI.italic, i)}`)
}

export interface MarkdownRenderState {
  inCodeBlock: boolean
}

export function createMarkdownRenderState(): MarkdownRenderState {
  return { inCodeBlock: false }
}

// Vertical bar prefix for code-block lines (git-diff / GitHub-review style).
// Hide the ``` fence lines themselves — the bar IS the visual signal that
// this is code, no need to also show the markdown syntax.
const CODE_BAR = stylize(ANSI.gray, '▎ ')

/**
 * Render a single markdown line, threading `state` across calls. Returns the
 * rendered line, or `null` for hidden ``` fence lines. Both `renderMarkdown`
 * and the streaming renderer go through this, which is what guarantees their
 * outputs are byte-identical.
 */
export function renderMarkdownLine(raw: string, state: MarkdownRenderState): string | null {
  if (raw.trimStart().startsWith('```')) {
    state.inCodeBlock = !state.inCodeBlock
    return null // hide fence lines
  }
  if (state.inCodeBlock) {
    // Keep content in the terminal's default color so it's readable; the bar
    // alone is enough of a "this is code" signal. Empty code lines still get
    // a bar so the block's left edge is unbroken.
    return `${CODE_BAR}${raw}`
  }

  // Headers. Anchor the captured text to start with `\S` (non-space) so the
  // regex engine can't backtrack into the ` +` separator, defusing the
  // `regexp/no-super-linear-backtracking` lint. Real markdown headers
  // require a space and non-empty content anyway.
  const headerMatch = raw.match(/^(#{1,6}) +(\S.*)$/)
  if (headerMatch) {
    // Leading '\n' = the blank separator line the buffered renderer emits
    // above every header.
    return `\n${stylize(`${ANSI.bold}${ANSI.green}`, headerMatch[2])}`
  }

  // Numbered list (preserve the number)
  const numberedMatch = raw.match(/^([ \t]*)(\d+)\. +(\S.*)$/)
  if (numberedMatch) {
    const [, indent, n, rest] = numberedMatch
    return `${indent}${stylize(ANSI.yellow, `${n}.`)} ${renderInline(rest)}`
  }

  // Bullet list
  const bulletMatch = raw.match(/^([ \t]*)[-*] +(\S.*)$/)
  if (bulletMatch) {
    const [, indent, rest] = bulletMatch
    return `${indent}${stylize(ANSI.yellow, '•')} ${renderInline(rest)}`
  }

  return renderInline(raw)
}

export function renderMarkdown(md: string, isTTY: boolean = process.stdout.isTTY === true): string {
  if (!isTTY)
    return md // keep raw markdown when piped/redirected

  const state = createMarkdownRenderState()
  const out: string[] = []
  for (const raw of md.split('\n')) {
    const line = renderMarkdownLine(raw, state)
    if (line !== null)
      out.push(line)
  }
  return out.join('\n')
}

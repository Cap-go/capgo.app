/**
 * Builds the `sh -c` script used by the `run_command` MCP tool.
 *
 * The user command runs under `setsid`, so it leads a fresh session and process
 * group. Backgrounded children (for example `sleep 600 &`) stay in that group, so
 * one `kill -KILL -<pgid>` removes all of them and releases the stdout pipe.
 * The group is killed when the command finishes, when the in-container watchdog
 * fires after `timeoutMs`, or when the wrapper shell receives TERM/INT/HUP (for
 * example from `proc.kill()` or the exec abort signal).
 */
export function buildRunCommandScript(command: string, timeoutMs: number): string {
  const escaped = command.replace(/'/g, `'\\''`)
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return [
    `setsid sh -c '${escaped}' &`,
    'p=$!',
    `setsid sh -c "sleep ${timeoutSeconds}; kill -KILL -$p" </dev/null >/dev/null 2>&1 &`,
    'w=$!',
    'trap \'kill -KILL -$p 2>/dev/null; kill -KILL -$w 2>/dev/null; exit 143\' TERM INT HUP',
    'wait $p',
    'rc=$?',
    'kill -KILL -$p 2>/dev/null',
    'kill -KILL -$w 2>/dev/null',
    'exit $rc',
  ].join('\n')
}

# Remove the CLI terminal pixel-size query

## Problem

CLI onboarding replay currently writes the xterm `CSI 14 t` control sequence to
stdout and temporarily claims stdin in raw mode to read the response. Some
terminal emulators expose that response as visible text, and replay telemetry
must not alter or compete with the interactive onboarding UI.

## Design

Remove the runtime terminal pixel-size query and all code used exclusively by
that query. Size replay frames from `stdout.columns` and `stdout.rows` using the
existing canonical replay cell metrics and existing resize handling.

An explicitly supplied `terminalPixelSize` remains supported for deterministic
tests and callers. This keeps the current replay rendering contract without
writing terminal queries or reading stdin during normal CLI execution.

## Scope

This change does not alter replay sampling, batching, delivery, redaction,
scrollback, or the rrweb event format. Those reliability improvements belong in
separate pull requests.

## Verification

- Add a regression test proving normal replay startup does not write `CSI 14 t`
  or change stdin raw mode.
- Keep coverage showing that explicit pixel dimensions still override the
  columns/rows-derived fallback.
- Run the CLI replay test and the repository CLI checks.

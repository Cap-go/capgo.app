# Show Failed Build Logs Design

## Goal

Let users reopen and scroll the captured build output after a build failure without changing the automatic transition to the AI debug prompt.

## Interaction

- Add `👀 Show me the build logs` immediately above `Skip` in the failed-build menu on iOS and Android.
- Selecting it opens a dedicated read-only build-log view backed by the existing in-memory `buildOutput` lines.
- The view opens at the bottom of the log and retains the existing build-viewer scrolling keys.
- Esc or Enter returns to the failed-build menu.
- Reopening the log must not enter `requesting-build`, clear the captured lines, or submit another build.
- The existing automatic transition from a failed build to the failed-build menu remains unchanged.

## Implementation

Add an Ink-only `build-log-view` onboarding state. Reuse `FullscreenBuildOutput` with an optional exit callback so its default streaming behavior stays unchanged during `requesting-build`, while the dedicated view shows a completed failure footer and can return to `ai-analysis-prompt`.

## Testing

- Verify both platform prompts render the new option above Skip.
- Verify the read-only viewer starts at the bottom and presents a dismissal hint without a running spinner.
- Keep the existing scrolling regression tests green.


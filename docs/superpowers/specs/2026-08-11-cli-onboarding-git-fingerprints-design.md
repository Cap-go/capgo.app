# CLI Onboarding Git Fingerprints Design

## Problem

The CLI checks for a dirty Git repository on every onboarding invocation. This is useful before onboarding starts, but it also runs after restoring saved progress. Automatic onboarding operations may already have changed `package.json`, a lockfile, Capacitor configuration, or source files. A user who stops and resumes therefore sees the same warning used for unrelated local edits, even when every dirty file still exactly matches a change made by the previous Capgo run.

Selecting **Continue anyway** only bypasses the check for the current invocation. It is intentionally not persisted, so it does not solve the resume defect.

## Goals

- Suppress the dirty-Git warning when every current dirty entry exactly matches a successful automatic mutation made by the same onboarding progress record.
- Continue warning when any path is unknown or has changed since Capgo recorded it.
- Discover package-manager and generated filenames dynamically rather than maintaining a filename list.
- Keep the change local to the existing onboarding progress and Git-check code.
- Preserve existing behavior for manual setup paths and older progress records.

## Non-goals

- Persisting a general “ignore dirty Git” preference.
- Treating user-run manual commands or edits as Capgo-owned.
- Proving filesystem authorship beyond an exact before/after comparison around a CLI-controlled operation.
- Refactoring the onboarding state format into a new subsystem.
- Changing Git state, staging files, committing files, or cleaning the repository for the user.

## Chosen Design

### Progress data

Add one optional field to the existing local onboarding progress JSON:

```ts
interface InitGitChangeFingerprint {
  status: string
  sha256: string | null
  mode: number | null
}

interface InitGitChanges {
  version: 1
  repoRoot: string
  files: Record<string, InitGitChangeFingerprint>
}
```

Keys are Git-relative paths using `/` separators. `status` preserves the two-character porcelain status so staged, unstaged, untracked, and deleted states do not compare as equivalent. `sha256` hashes the raw working-tree bytes and is `null` when no working-tree file exists. `mode` records the filesystem mode and is `null` for an absent file.

The field is optional. A progress file without it retains the current conservative dirty-Git behavior.

### Tracking automatic mutations

Add one reusable helper that runs an automatic mutation between two Git snapshots. It returns the operation result unchanged and accepts a success predicate for APIs that report failure without throwing:

```ts
await runTrackedInitMutation(
  () => automaticMutation(),
  { startDir, scope, isSuccess: result => result.success },
)
```

The helper:

1. Captures the dirty-path fingerprints immediately before the operation.
2. Runs the operation.
3. Captures fingerprints immediately after successful completion.
4. Compares the two maps and updates only paths whose fingerprint changed.
5. Removes a previously owned path when the operation returns it to a clean state.
6. Persists the accumulated map through the existing onboarding progress writer without advancing `step_done`.

This is deliberately operation-scoped, not step-scoped. Prompts, waits, and manual work are outside tracked windows. For example, if `src/main.ts` is already dirty before the automatic dependency installation, and the installation changes only `package.json` and a lockfile, only the package files are added.

An operation that throws is unsuccessful. An operation that returns a result is successful when its supplied predicate returns `true`; operations that return `void` are successful when they return without throwing. If an operation fails after partially changing files, those changes remain unrecognized and the next resume uses the existing warning.

Instrument only existing automatic repository mutations in the onboarding command:

- CLI-run package installations.
- CLI-run Capacitor `init`, platform-add, and sync commands.
- Direct Capacitor/app/updater configuration writes.
- Automatic updater source injection.
- Automatic encryption key/configuration creation.
- Automatic temporary test edits and their cleanup.

Do not wrap user prompts, manual-install/manual-edit waits, project build scripts, uploads, or commands the user runs themselves. The existing special handling for the temporary auto-test change remains as a backward-compatible fallback rather than being refactored away in this PR.

### Minimal persistence change

Keep the existing progress payload and file. Extract its current serialization into a small shared writer used by:

- `markStepDone()`, which updates `step_done` and writes progress as today.
- `runTrackedInitMutation()`, which writes an updated optional `gitChanges` field while preserving the last completed step.

If no resumable progress has been established yet, tracked fingerprints stay in memory and are included by the next normal `markStepDone()` call. This avoids creating a step-zero progress record that the current resume logic would reject.

### Resume classification

After restoring progress and before showing the dirty-Git prompt, classify every current dirty entry:

- **Recognized:** repository roots match and path, status, SHA-256, and mode exactly match the saved fingerprint.
- **Unsafe:** no saved entry exists, any fingerprint field differs, the saved data is invalid, the repository root differs, or the current file cannot be fingerprinted.

Saved paths that are no longer dirty are discarded so an old fingerprint cannot become trusted again after a commit or cleanup.

The user experience is:

| Current state | Behavior |
| --- | --- |
| Repository clean | Continue normally. |
| Every dirty entry recognized | Skip the warning and print a neutral line: `Resuming with uncommitted changes created by the previous Capgo onboarding run.` |
| At least one unsafe entry | Reuse the existing warning and its **Check again** / **Continue anyway** actions, but list only unsafe entries. When recognized entries also exist, note their count separately. |
| No valid saved fingerprints | Treat every dirty entry as unsafe, matching current behavior. |

**Continue anyway** remains scoped to the current invocation. It does not add unknown files to the saved fingerprint set. A later resume warns again unless those files subsequently become part of a successful automatic tracked mutation.

## Failure Handling

Fingerprint tracking is an optimization and must not break onboarding.

- A Git, filesystem, hashing, or parsing failure logs through the existing diagnostic path and records no new trusted state.
- A progress write failure leaves no durable new trusted state; the current onboarding run continues.
- An unsupported or unreadable dirty entry remains unsafe.
- Rename, copy, symlink, directory, and other non-regular-file states remain unsafe rather than gaining special tracking logic.
- A failed automatic operation records no fingerprints, including partial filesystem changes.
- Malformed, unknown-version, or wrong-repository saved data is ignored and falls back to the existing warning.
- No recovery path mutates Git or removes user files.

## Minimal Code Scope

Keep the production change in the existing onboarding command file unless a pre-existing test boundary requires otherwise:

- One SHA-256 import.
- Small fingerprint/progress types.
- Snapshot, diff/update, tracking, and classification helpers.
- One optional progress field restored and serialized with existing state.
- Small wrapper calls only at automatic mutation sites.
- A conditional branch inside the existing dirty-Git warning flow.

Do not introduce a service, database change, new prompt, or broad onboarding refactor. Keep the package-manager knowledge local to the tracker and limited to selecting the manifest and known lockfiles that an automatic install may claim.

## Testing

Use focused guardrail tests rather than a full end-to-end onboarding suite. Keep the original three behavioral groups, and add compact regressions where conservative attribution or destructive-path safety depends on an edge case:

1. **Attribution regression:** `src/main.ts` is dirty before a tracked operation changes `package.json` and a lockfile; only the package files are recorded.
2. **Resume classification:** table-driven cases cover an exact match, changed fingerprint, additional path, and absent saved data.
3. **Conservative failure:** a failed snapshot or automatic operation records no trusted changes.

Include staged, deleted, and mode-changed fingerprints as rows in the same classification table. Cover raw whitespace/Unicode Git paths, malformed progress, persistence failures, scoped automatic operations, and native-reset path/symlink safety with focused fixtures. Do not add a full end-to-end onboarding test for this isolated behavior.

## Alternatives Considered

- **Persist “Continue anyway”:** smallest implementation, but it silently accepts unrelated edits made after the user opted out and weakens the safety check.
- **Hard-code expected filenames:** small initially, but brittle across npm, Yarn, pnpm, Bun, Capacitor configuration variants, and generated files.
- **Snapshot whole onboarding steps:** fewer tracking call sites, but incorrectly attributes unrelated edits made between prompts or steps to Capgo.
- **Recommended — operation-scoped before/after fingerprints:** slightly more call sites, but remains small and preserves the boundary between automatic Capgo changes and unrelated user work.

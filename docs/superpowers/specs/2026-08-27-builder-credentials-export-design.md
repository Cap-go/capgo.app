# Builder Credential Export Command Design

**Date:** 2026-08-27

**Status:** Approved design, ready for implementation planning

## Summary

Add a small, Commander-only Capgo CLI command that exports one saved Builder
credential or configuration value. The command can either write the exact value
to stdout for scripting or save it to a new file. It reads only Capgo's saved
local and global Builder credential stores; environment variables are never an
export source.

The feature must remain simple. Production source changes must stay below 400
changed lines in total. Tests, generated documentation, this specification, and
the implementation plan do not count toward that limit.

## Goals

- Export exactly one named Builder value for one app.
- Support automation-safe raw output with no extra stdout bytes.
- Support safe file output without overwriting an existing path.
- Make ambiguous source or platform selection fail instead of guessing.
- Reuse the Base64 classification already used by `build credentials manage`.
- Keep the existing Builder MCP surface unchanged.

## Non-goals

- Exporting environment variables.
- Exporting an entire platform as a `.env` file.
- Adding or changing an MCP tool.
- Mutating saved credentials.
- Overwriting an existing file, including through a force option.
- Automatically decoding a value solely because its name or content looks like
  Base64.

## Command interface

The public command is:

```sh
npx @capgo/cli@latest build credentials export <VARIABLE> \
  --app-id <APP_ID> \
  (--file <PATH> | --raw)
```

Required inputs:

- `<VARIABLE>`: the exact stored field name to export. The command does not use
  a hardcoded allowlist; any actual string field in the selected saved platform
  configuration may be exported.
- `--app-id <APP_ID>`: the app whose saved Builder configuration is inspected.
  `--appId <APP_ID>` is accepted as a compatibility alias, while help and
  customer documentation use `--app-id`.
- Exactly one output selector:
  - `--raw`
  - `--file <PATH>`

Optional selectors:

- `--platform <ios|android>`
- `--local`
- `--global`
- `--decode-base64`, valid only with `--file`

Invalid combinations fail with exit status 1 and a diagnostic on stderr:

- neither or both of `--raw` and `--file`
- both `--local` and `--global`
- `--decode-base64` with `--raw`
- an unsupported platform
- `--file -`, because stdout export must use `--raw`

The command's `--help` explicitly documents that raw mode prints only the stored
value to stdout, adds no newline, writes all diagnostics to stderr, and exits 1
when it cannot export the requested value.

## Saved-source resolution

The only possible sources are:

- project-local `.capgo-credentials.json`
- global `~/.capgo-credentials/credentials.json`

An app is considered configured in a source when its app record contains at
least one string-valued credential field under either `ios` or `android`.
String fields with an empty value still count because an empty password may be
intentional.

Resolution proceeds as follows:

1. Load the local and global saved records for the requested app independently.
2. If `--local` or `--global` is passed, inspect only that source. Do not fall
   back when the requested app, platform, or variable is absent there.
3. Without an explicit source selector:
   - if only one source configures the app, use it;
   - if both sources configure the app, fail and require `--local` or
     `--global`;
   - if neither source configures the app, fail.

There is deliberately no local-over-global precedence for this command. The
presence of configuration in both stores is enough to require an explicit
choice, even if the requested values happen to match.

The implementation may report the selected source path in file mode. Raw mode
must never print that path to stdout.

## Platform resolution

A platform is configured when its saved object contains at least one
string-valued field. A variable is present when the requested property exists
and its value is a string; an empty string is a valid exportable value.

With `--platform`, the command inspects only that platform. It fails if the
platform is not configured or the variable is absent. It never falls back to
the other platform.

Without `--platform`:

- If exactly one platform is configured, use it and require the variable there.
- If both platforms are configured and both contain the variable with identical
  string values, export that value.
- If both platforms are configured and the values differ, fail and require
  `--platform`.
- If both platforms are configured but only one contains the variable, fail and
  require `--platform` rather than assuming the platform that has it.
- If neither platform contains the variable, fail.

Diagnostics may identify source names, platform names, paths, and available
field names, but must never print credential values.

## Raw output behavior

`--raw` is intended for shell scripts and pipes:

- stdout contains only the exact stored string value;
- no trailing newline is added;
- an empty stored value produces zero stdout bytes and still succeeds;
- success produces no banner, label, spinner, warning, or color code on stdout;
- all diagnostics, including errors, go to stderr;
- every failure exits with status 1;
- success exits with status 0.

The raw value is not decoded or otherwise transformed. `--decode-base64` is
therefore rejected with `--raw`.

## File output behavior

`--file <PATH>` uses normal human-facing CLI formatting. On success it may state:

- the exported variable name;
- whether local or global storage was used and its absolute source path;
- the selected or resolved platform;
- the absolute destination path;
- whether the value was written literally or decoded.

File safety rules:

- The destination must not already exist. Existing files, directories, and
  symbolic links all cause failure.
- There is no `--force` option and no overwrite path.
- Creation must be exclusive and race-safe, using the equivalent of `wx`.
- The created file mode is `0600`.
- Parent directories are not created implicitly.
- Without decoding, the stored string is written exactly as UTF-8 bytes with no
  newline. An empty value creates an empty file.
- With decoding, the decoded bytes are written directly.
- If writing fails, the command reports the failure on stderr and exits 1.

## Base64 behavior

The current `build credentials manage` command has one canonical eligibility
rule for values that may represent Base64. It recognizes:

- names ending in `_BASE64`;
- `APPLE_KEY_CONTENT`;
- `ANDROID_KEYSTORE_FILE`;
- `PLAY_CONFIG_JSON`;
- sufficiently long values matching the existing Base64 heuristic;
- and explicitly excludes `CAPGO_IOS_PROVISIONING_MAP`.

That existing rule will be extracted into a small shared helper and consumed by
both `credentials manage` and the new export command. This avoids maintaining a
second list and preserves existing manage behavior.

File-mode behavior is:

1. `--decode-base64` explicitly requests decoding. Decoding accepts standard
   padded or unpadded Base64 and ignores ASCII whitespace. Invalid characters,
   padding, or length must fail without creating or replacing a destination
   file.
2. Without the flag, if the shared helper does not classify the value as
   Base64-capable, write it literally.
3. Without the flag, if the helper classifies it as Base64-capable and the
   process is interactive, ask whether to decode it.
4. If the user accepts, decode and write the bytes. If the user declines, write
   the stored Base64 text literally and state that it was not decoded.
5. In non-interactive file mode, never prompt. Write the stored Base64 text
   literally and warn that `--decode-base64` can be used to decode it.

Detection only controls prompting and warnings. It never causes automatic
decoding in a non-interactive invocation.

## Error handling and secret safety

CLI inputs and saved values are treated as untrusted strings. Error messages
must not interpolate credential values.

Expected failures include:

- invalid option combinations;
- missing local/global app configuration;
- ambiguous source selection;
- missing or ambiguous platform selection;
- missing variable;
- invalid Base64 when decoding was requested;
- an existing destination;
- file-system read or write errors.

Each failure writes a concise actionable message to stderr and sets exit status
1. Errors should tell the user which selector can resolve an ambiguity without
revealing the value itself.

## Architecture

Use the dedicated-command approach:

1. Add a small command module, expected to be
   `cli/src/build/credentials-export-command.ts`, containing argument
   validation, deterministic source/platform resolution, output handling, and
   command registration.
2. Extract the existing Base64 eligibility function from
   `cli/src/build/credentials-manage.ts` into one small shared Builder
   credential utility and import it from both callers.
3. Reuse the existing saved-credential schema and exact local/global loading
   helpers from `cli/src/build/credentials.ts`. Do not use merged credentials,
   because merged credentials can include environment variables.
4. Register the CLI command beneath `build credentials` in `cli/src/index.ts`.
5. Do not add any MCP schema, handler, registration, or documentation. The
   existing MCP credential-management behavior, including its whole-platform
   `.env` export action, remains unchanged.

Resolution should be implemented as small pure functions where practical so
ambiguity and empty-string behavior can be tested without file-system setup.

## Test strategy

Tests must cover the command contract without exposing secrets in failures or
snapshots.

### Argument validation

- variable and app ID are required;
- both `--app-id` and `--appId` work;
- exactly one of raw/file is required;
- local/global are mutually exclusive;
- decode/raw are mutually exclusive;
- `--file -` is rejected;
- help documents stdout, stderr, newline, and exit behavior.

### Source resolution

- local-only and global-only automatic selection;
- explicit source selection with no fallback;
- both stores configured requires a selector even when values match;
- neither store configured fails;
- empty string fields count as saved configuration.

### Platform resolution

- one configured platform resolves automatically;
- equal values on both configured platforms resolve automatically;
- different values require `--platform`;
- one-sided variable with both platforms configured requires `--platform`;
- explicit platform never falls back;
- missing variable fails;
- empty stored values export successfully.

### Output and file safety

- raw stdout is byte-exact and has no newline;
- raw success emits no other stdout content;
- raw diagnostics and all failures use stderr and status 1;
- literal file export preserves the exact stored string and adds no newline;
- explicit and interactive decoding write the expected bytes;
- non-interactive Base64-capable output stays encoded and warns;
- existing destinations and symlinks are not overwritten;
- newly created files have mode `0600`;
- invalid Base64 and write errors do not leave a misleading successful output.

### Regression boundaries

- existing `credentials manage` Base64 decisions remain unchanged after helper
  extraction;
- existing Builder credential tests continue to pass;
- no new MCP tool or MCP action is registered.

## Documentation

- Add complete Commander help for the new command.
- Update the CLI Builder documentation using the repository's normal generated
  documentation workflow where applicable.
- Use customer-facing `npx @capgo/cli@latest ...` examples and canonical
  kebab-case option names.
- Document that export reads saved configuration only, never environment
  variables.
- Document ambiguity errors and their `--local`, `--global`, and `--platform`
  remedies.
- Document literal Base64 file output and `--decode-base64`.

## Change-size and verification gates

- Production TypeScript changes must remain strictly below 400 changed lines,
  counted as additions plus deletions in production source files. Tests,
  generated docs, the design specification, and implementation plan are
  excluded.
- Run focused export and credentials-manage tests while developing.
- Before handoff, run the CLI lint/typecheck/build/test workflow appropriate to
  the changed package, including `bun run cli:check` when feasible.
- Verify the production line count from the final Git diff.
- Verify the diff contains no MCP registration change and no unrelated
  `codedb.snapshot` change.

## Acceptance criteria

The feature is complete when a user can safely export one saved Builder value
to either exact raw stdout or a newly created file, every ambiguous selection
fails with an actionable non-secret diagnostic, Base64 behavior matches this
specification, the existing MCP surface is unchanged, all relevant tests pass,
and production code changes remain below the strict 400-line limit.

# Authenticated CLI Invocation Design

## Problem

The universal Commander `preAction` hook emits `CLI Command Invoked` before
`login` or `init` has validated the API key supplied to that command. The
generic analytics helper can only use `CAPGO_TOKEN`, `~/.capgo`, or `./.capgo`
at that point. For first-time users this drops the event; for users with an old
saved key it can attribute the event to the wrong Capgo person.

`login` and `init` also expose a legacy positional API-key argument but do not
accept the standard `-a, --apikey` option used by other authenticated commands.

## Requirements

- `login` and `init` must emit one `CLI Command Invoked` event themselves only
  after the supplied API key has been validated against Capgo.
- Failed or cancelled authentication must not emit the invocation event.
- The event must use the validated key explicitly; it must not fall back to a
  saved or environment key.
- The universal `preAction` hook must not emit an invocation for `login` or
  `init`, but it must continue recording command start time and privacy-safe
  command context for later emission.
- Other commands must retain their existing pre-action invocation behavior.
- `login` and `init` must accept `-a, --apikey <apikey>`.
- The flag must override the legacy positional key when both are supplied.
- `init -a KEY com.example.app` must interpret `com.example.app` as the app ID,
  while preserving `init KEY com.example.app` compatibility.
- Telemetry must remain best-effort and must never break a successful command.

## Design

The analytics module will hold a single deferred invocation because the CLI
runs one Commander command per process. The pre-action hook will always start
the command timer. For `login` and `init` it will store the command path and
privacy-safe `CommandContext` without sending. For all other commands it will
send immediately as today.

After authentication succeeds, the top-level `login` action and `initApp`
will flush the deferred invocation with the validated API key passed directly
to `trackEvent`. Flushing consumes the deferred record, making repeated calls
idempotent and preventing duplicate invocation events. `loginInternal` remains
reusable by SDK and init flows and will not implicitly flush another command's
telemetry.

Small pure argument-normalization helpers will resolve the flag/positional
forms. Login uses `--apikey` before its positional argument. Init uses the flag
before its positional key and, when the flag is present with one positional
argument, treats that argument as the app ID.

## Validation and Error Handling

`login` flushes only after `validateAndSaveKey` returns. `init` flushes only
after `createSupabaseClient` and `resolveUserIdFromApiKey` return. Therefore an
invalid key, cancelled prompt, or authentication error exits before invocation
telemetry is emitted. Analytics transport errors remain swallowed by the
existing best-effort sender.

## Testing

- Analytics tests prove deferred commands send nothing before flush, use the
  explicit validated key, emit once, and preserve the original timer/context.
- Command-input tests prove positional compatibility, flag precedence, and the
  `init -a KEY APP_ID` ambiguity resolution.
- Source/command contract tests prove both commands expose `-a, --apikey`, the
  pre-action hook defers them, and each command flushes only after its existing
  Capgo validation call.
- Focused CLI tests run first for red/green evidence, followed by CLI lint,
  typecheck, build, and the complete CLI test suite.

## Non-goals

- Changing authentication persistence or API-key validation semantics.
- Changing command lifecycle event names or payload properties.
- Retrofitting deferred authentication into other commands.
- Changing the onboarding dashboard classification in this pull request.

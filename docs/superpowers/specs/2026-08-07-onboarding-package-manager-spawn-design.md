# Onboarding Package Manager Spawn Design

## Problem

The CLI infers a project's package manager from its lockfile and assumes the matching executable is available in the CLI process's `PATH`. When the executable is missing, `spawn()` emits an `ENOENT` error and then a `close` event with code `-2`. The streaming UI handles both events, so the useful `ENOENT` message is replaced by `Command exited with code -2`.

## Behavior

The onboarding build flow will keep using direct child-process spawning without a shell or PTY. Before starting a streamed command, the runner will verify that the executable can be launched from the inherited environment.

When the package manager inferred from the lockfile is unavailable, onboarding will inspect the supported alternatives (`npm`, `pnpm`, `yarn`, and `bun`). If any are installed, it will ask the user to select one explicitly and use that selection for both the web build and Capacitor sync. It will never switch package managers silently. If none are available, it will report that the detected executable was not found in `PATH`.

## Structure

A focused command-execution module will own executable probing, supported package-manager metadata, alternative discovery, and child-process settlement. The existing onboarding command module will retain UI prompts and streaming-panel integration.

The child-process settlement helper will resolve exactly once. An `error` event wins if it arrives first, while a normal `close` event still reports success or the real nonzero exit code. This also protects against a time-of-check/time-of-use failure after a successful preflight.

## Testing

Regression coverage will prove that:

- an executable absent from `PATH` is reported as unavailable;
- installed package-manager alternatives are discovered without including the missing detected manager;
- package-manager metadata produces the correct command and runner;
- a child `error` followed by `close(-2)` preserves the original `ENOENT` error;
- normal zero and nonzero process exits retain their existing behavior.

Focused CLI tests will run before the CLI lint, typecheck, build, and full CLI test gates required by the repository.

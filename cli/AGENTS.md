# Agent Requirements

- Every CLI build must run the MCP smoke test (`bun run test:mcp`).
- Every CLI build must also run the bundle integrity test (`bun run test:bundle`).
- Treat failures in these tests as release blockers.
- End-to-end CLI testing is done in the Capgo repo; in this CLI repo, focus tests on behavior specific to the CLI code and avoid treating backend end-to-end coverage as belonging here.
- Capgo publishes `minCliVersion` + `minCliVersionReason` on `GET /private/config`. The CLI must refuse to continue when it is older than that floor, and must show the reason plus `npx @capgo/cli@latest`. Do not hardcode the floor in the CLI; read it from config.
- In the Capgo repo, CLI compatibility tests pin to `MIN_CLI_VERSION` from `supabase/functions/_backend/utils/cliMinVersion.ts`. Before changing public CLI/API contracts, ask whether to raise that floor and whether the change is a security concern. See the Capgo repo `AGENTS.md` section "CLI Minimum Version".
- Keep `src/index.ts` limited to CLI command registration, options, and wiring.
- Put command implementation logic in dedicated modules/handlers instead of inline `.action(...)` bodies in `src/index.ts`.
- When adding or changing a CLI command, prefer an exported command handler function in a dedicated module and wire it from `src/index.ts`.
- CLI command names must be lowercase and should use kebab-case for multiple words. Do not add camelCase, PascalCase, or other cased command names.
- When adding or changing a CLI command, command option, or CLI-facing workflow, update the TanStack Intent skill docs in `skills/` as part of the same change so the published skills stay aligned with `webdocs/` and `src/index.ts`.
- For end-customer-facing docs and skills in `skills/` and `webdocs/`, use generic command runners in examples (`npx @capgo/cli@latest ...`) instead of Bun-specific runners. Reserve `bun` and `bunx` for repo-local development and agent execution.
- Reuse shared option descriptions from `src/index.ts` when an option already exists instead of introducing slightly different wording.
- For CLI-facing output, use `@clack/prompts` (`log`, `spinner`, `intro`, `outro`, `confirm`, `select`) to stay consistent with the rest of the CLI UX.
- If a command may run in non-interactive mode, do not rely on spinner-only output; provide plain log output or a non-TTY fallback.
- For user-visible error messages, format errors with `formatError(...)` instead of dumping raw exceptions when possible.
- Validate new SDK or MCP inputs with Zod schemas in `src/schemas/*` and reuse those schemas from the SDK/MCP layer instead of duplicating validation logic.
- If a CLI feature is exposed through the SDK or MCP server, keep the option shape aligned across `src/index.ts`, `src/schemas/sdk.ts`, `src/sdk.ts`, and `src/mcp/server.ts`.
- Prefer small reusable helpers for parsing and normalization logic instead of repeating ad hoc parsing inside command bodies.
- Preserve the current command naming structure (`app/*`, `bundle/*`, `channel/*`, `organization/*`, etc.) and add new commands in the closest existing domain module.
- Prefer silent/internal helper variants for reusable business logic when the same operation is needed by CLI, SDK, onboarding, or MCP flows.

## Local verification after a task

To reduce CI failures, run the relevant local checks after finishing a task.

- Minimum required for CLI changes:
  - `bun run lint`
  - `bun run build`
  - `bun run test:mcp`
  - `bun run test:bundle`

- Recommended full local verification before pushing significant CLI changes:
  - `bun install --frozen-lockfile`
  - `bun run lint`
  - `bun run build`
  - `./test/fixtures/setup-test-projects.sh`
  - `bun run test`
  - `node dist/index.js --help`
  - `node dist/index.js --version`

- Notes:
  - `bun run lint` uses `eslint --fix`, so review any file changes it makes.
  - `bun run test` already includes `test:mcp`, `test:bundle`, `test:esm-sdk`, version detection, platform path, payload split, and other CLI-specific validation scripts.
  - Remote CI also runs extra environment-specific checks such as the Node.js version matrix, typo checks, ZIP/POSIX path checks across operating systems, and backend-integrated CLI E2E from the Capgo repo.
  - Do not treat backend E2E as a blocker to add in this repo unless the task specifically requires coordinating with the Capgo repo.

This is critical to prevent hardcoded build paths or MCP regressions from reaching customers.

# Capgo CLI skill spec

## Goal

Provide a small Capgo CLI skill set that helps an agent choose and invoke the correct CLI commands for app setup, OTA release operations, organization administration, MCP setup, GitHub support commands, Observe queries, and native cloud builds without exceeding TanStack Intent size limits.

## Sources

- `webdocs/*.mdx` for published command descriptions, examples, and option tables.
- `src/index.ts` for the currently registered commands, aliases, and flags that may not yet be fully reflected in the web docs.
- `AGENTS.md` for repository-specific maintenance requirements.

## Skill set

- `usage`: routing, setup, diagnostics, app commands, docs generation, MCP, and GitHub support commands.
- `observe`: Observe query commands and MCP (`summary`, `metrics`, `events`, `device`, `versions`, `routes`).
- `release-management`: bundle, channel, compatibility, cleanup, and encryption-key workflows.
- `native-builds`: native cloud build requests and build credential storage/update flows.
- `organization-management`: account ID lookup, organization admin flows, and deprecated `organisation` aliases.

## Scope

- Include the documented command purpose, invocation patterns, key options, and important caveats.
- Prefer the public user-facing examples already used by the project.
- Keep the skills aligned with the published docs and current CLI registration.

## Maintenance rules

- Any CLI command or option change should update the relevant `skills/*/SKILL.md` file in the same pull request.
- Use `webdocs/` as the primary wording source and `src/index.ts` as the completeness check.
- Validate the skills with `bunx @tanstack/intent@latest validate` before release.

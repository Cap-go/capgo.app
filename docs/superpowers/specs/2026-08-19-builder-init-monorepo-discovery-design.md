# Builder Init Monorepo Discovery Design

## Goal

Allow the direct `npx @capgo/cli@latest build init` entrypoint to find a
Capacitor app when it is launched from the root of a package-manager workspace,
without recursively crawling arbitrary folders or searching above the directory
where the command was invoked.

## Scope

This change applies only to the direct `build init`/`build onboarding`
entrypoint. Existing indirect onboarding launched by `bundle upload` or
`build credentials manage` keeps its current current-directory behavior.

The first version supports workspace layouts understood by `@manypkg/tools`:
npm, Yarn, pnpm, Bun, Lerna, and Rush. Tools such as Turbo and Nx work when
their projects are also declared through one of those package-manager workspace
formats. Nx layouts that exist only through `nx.json`, `project.json`, or inferred
Nx projects are intentionally unsupported.

## Search Boundary

The invocation directory is the immutable search root.

- If that directory already contains `capacitor.config.ts`,
  `capacitor.config.js`, or `capacitor.config.json`, onboarding proceeds exactly
  as it does today.
- Otherwise, the invocation directory must contain `package.json`. If it does
  not, discovery stops immediately.
- Workspace metadata is read only from the invocation directory.
- Only the workspace root and package directories returned by
  `@manypkg/tools` are checked for Capacitor config files.
- Discovery never walks to a parent directory and never recursively scans
  arbitrary descendants.
- Returned package directories are canonicalized and rejected if they escape
  the invocation root, including through symlinks or `..` paths.

## Workspace Adapter Selection

The CLI chooses an exact-root `@manypkg/tools` adapter from root metadata. It
does not use an API that walks upward to locate a monorepo root.

Adapter priority is:

1. `pnpm-workspace.yaml` -> `PnpmTool`
2. `rush.json` -> `RushTool`
3. `lerna.json` -> `LernaTool`
4. Bun package-manager metadata or lockfile -> `BunTool`
5. Yarn package-manager metadata, lockfile, or object-form workspaces ->
   `YarnTool`
6. npm metadata, lockfile, or array-form workspaces -> `NpmTool`

An array-form `workspaces` field without another package-manager marker falls
back to `NpmTool`, which provides the generic package-glob expansion needed by
the generic fixtures. If no adapter can be selected, discovery fails instead
of crawling the filesystem.

## Candidate Detection and Selection

Each candidate is a workspace package directory containing one of the three
supported Capacitor config filenames. Candidates are sorted by their path
relative to the invocation directory so the prompt is stable.

- One descendant candidate: ask the user to confirm that app.
- Multiple candidates: show a select prompt containing package names and
  relative paths.
- Cancellation or rejection ends discovery without starting onboarding.
- Once selected, the process changes its working directory to the app directory
  before loading the Capacitor config, resolving native platform paths, starting
  logs/replay, or rendering the existing onboarding wizard.

The prompt runs before the Ink onboarding wizard. A short spinner tells the
user that Capgo is inspecting workspace metadata; this keeps the implementation
small and avoids a second full-screen Ink application.

## Failure Experience

Missing `package.json`, unsupported workspace metadata, invalid workspace
metadata, and zero Capacitor candidates share one actionable failure:

> We couldn't find a Capacitor app in this project.
>
> Run `npx @capgo/cli@latest build init` from your Capacitor app directory or
> from the root of a supported package-manager workspace.

When `nx.json` exists at the invocation root, append:

> Nx repositories that do not use package-manager workspaces are not currently
> supported.

This is preferable to broad recursive searching and makes unsupported Nx-only
layouts explicit.

## Testing

Unit tests create temporary workspace layouts and exercise the real
`@manypkg/tools` adapters. Coverage includes:

- current-directory Capacitor app detection;
- rejection when the invocation root lacks `package.json`;
- npm/Yarn/pnpm/Bun workspace discovery;
- generic array-form workspaces without a lockfile;
- one and multiple Capacitor candidates;
- ignoring non-Capacitor workspace packages;
- Nx-only failure and Nx plus package workspaces success;
- rejection of package paths that resolve outside the invocation root;
- stable candidate ordering.

Command-level tests cover confirmation, selection, cancellation, changing to
the selected app directory, and the shared actionable error wording. No
interactive key-helper or end-to-end TUI automation is required for this
feature.

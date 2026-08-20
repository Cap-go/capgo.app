# Builder Init Monorepo Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct `npx @capgo/cli@latest build init` discover and select Capacitor apps declared in package-manager workspaces rooted at the invocation directory.

**Architecture:** A filesystem-only discovery module selects an exact-root `@manypkg/tools` adapter and returns bounded Capacitor candidates. A small selection module converts one candidate into a confirmation and multiple candidates into a select prompt. The direct command runs these helpers before loading Capacitor configuration, changes cwd to the selected app, and then reuses the existing onboarding flow unchanged.

**Tech Stack:** TypeScript, Bun, `@manypkg/tools`, Ink, Node filesystem APIs, assertion-based CLI unit tests and TUI journeys.

---

## File Structure

- Create `cli/src/build/onboarding/project-discovery.ts`: exact-root workspace adapter selection, path containment, and Capacitor candidate discovery.
- Create `cli/src/build/onboarding/project-selection.ts`: prompt-independent one/many candidate selection rules.
- Create `cli/test/test-builder-project-discovery.mjs`: temporary workspace fixtures covering discovery and selection.
- Modify `cli/src/build/onboarding/command.ts`: direct-command discovery UX, shared failure message, cwd handoff.
- Modify `cli/src/index.ts`: explicitly enable discovery only for direct `build init`.
- Modify `cli/package.json`: add dependency and targeted test script.
- Modify `bun.lock`: lock `@manypkg/tools` and its transitive dependencies.

### Task 1: Specify discovery behavior with failing tests

**Files:**
- Create: `cli/test/test-builder-project-discovery.mjs`
- Modify: `cli/package.json`

- [ ] **Step 1: Write failing discovery tests**

Create temporary directories with helpers such as:

```js
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function addCapacitorApp(root, relativeDir, name, appId) {
  const dir = join(root, relativeDir)
  writeJson(join(dir, 'package.json'), { name, version: '1.0.0' })
  writeFileSync(join(dir, 'capacitor.config.ts'), `export default { appId: '${appId}' }\n`)
  return dir
}
```

Import the wished-for API:

```js
import {
  discoverCapacitorProjects,
  hasCapacitorConfig,
} from '../src/build/onboarding/project-discovery.ts'
import { selectCapacitorProject } from '../src/build/onboarding/project-selection.ts'
```

Cover these assertions as separate tests:

```js
assert.equal(hasCapacitorConfig(currentApp), true)
assert.equal((await discoverCapacitorProjects(rootWithoutPackageJson)).reason, 'missing-package-json')
assert.deepEqual((await discoverCapacitorProjects(npmRoot)).candidates.map(p => p.relativeDir), ['apps/mobile'])
assert.deepEqual((await discoverCapacitorProjects(multipleRoot)).candidates.map(p => p.relativeDir), ['apps/admin', 'apps/mobile'])
assert.equal((await discoverCapacitorProjects(nxOnlyRoot)).nxDetected, true)
assert.equal((await discoverCapacitorProjects(nxWorkspaceRoot)).candidates.length, 1)
```

Add real adapter cases for npm/generic array workspaces, Yarn object workspaces,
pnpm YAML workspaces, and Bun workspaces. Add a workspace glob or symlink case
that points outside the root and assert the outside app is absent.

For selection, inject prompt functions and assert:

```js
assert.equal((await selectCapacitorProject([only], {
  confirm: async candidate => candidate.dir === only.dir,
  select: async () => assert.fail('select must not run'),
}))?.dir, only.dir)

assert.equal((await selectCapacitorProject(multiple, {
  confirm: async () => assert.fail('confirm must not run'),
  select: async candidates => candidates[1].dir,
}))?.dir, multiple[1].dir)
```

Also verify rejected confirmation and prompt cancellation return `undefined`.

- [ ] **Step 2: Add the targeted script**

Add to `cli/package.json`:

```json
"test:builder-project-discovery": "bun test/test-builder-project-discovery.mjs"
```

Include `bun run test:builder-project-discovery` in the aggregate `test` script.

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
cd cli && bun run test:builder-project-discovery
```

Expected: FAIL because `project-discovery.ts` and `project-selection.ts` do not
exist.

### Task 2: Implement bounded workspace discovery

**Files:**
- Create: `cli/src/build/onboarding/project-discovery.ts`
- Modify: `cli/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add the runtime dependency**

Run from the repository root:

```bash
bun add --cwd cli @manypkg/tools@^2.1.2
```

Confirm `@manypkg/tools` is under `cli/package.json` `dependencies`, not
`devDependencies`.

- [ ] **Step 2: Implement the exact-root discovery API**

Define:

```ts
export type BuilderProjectDiscoveryReason
  = 'missing-package-json' | 'unsupported-workspace' | 'invalid-workspace' | 'no-capacitor-app'

export interface CapacitorProjectCandidate {
  dir: string
  relativeDir: string
  packageName?: string
}

export interface BuilderProjectDiscovery {
  searchRoot: string
  candidates: CapacitorProjectCandidate[]
  nxDetected: boolean
  reason?: BuilderProjectDiscoveryReason
}

export function hasCapacitorConfig(directory: string): boolean
export async function discoverCapacitorProjects(searchRoot: string): Promise<BuilderProjectDiscovery>
```

Use exactly these filenames:

```ts
const CAPACITOR_CONFIG_FILES = [
  'capacitor.config.ts',
  'capacitor.config.js',
  'capacitor.config.json',
] as const
```

Read only root metadata. Select `PnpmTool`, `RushTool`, `LernaTool`, `BunTool`,
`YarnTool`, or `NpmTool` using the priority in the design. Call
`tool.getPackages(searchRoot)` directly; do not call any root-finding API.

Canonicalize the search root and every returned package directory with
`realpath`. Keep a package only when this containment check passes:

```ts
const relativePath = relative(canonicalRoot, canonicalPackageDir)
const contained = relativePath === ''
  || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
```

Add the root itself as a candidate only when it has a Capacitor config. De-dupe
canonical directories, ignore workspace packages without a Capacitor config,
and sort candidates by `relativeDir`.

- [ ] **Step 3: Run discovery tests and verify partial GREEN**

Run:

```bash
cd cli && bun run test:builder-project-discovery
```

Expected: discovery assertions pass; selection import/assertions still fail
because `project-selection.ts` does not exist.

### Task 3: Implement deterministic project selection

**Files:**
- Create: `cli/src/build/onboarding/project-selection.ts`
- Test: `cli/test/test-builder-project-discovery.mjs`

- [ ] **Step 1: Implement the minimal selection API**

```ts
import type { CapacitorProjectCandidate } from './project-discovery.js'

export interface BuilderProjectPrompts {
  confirm: (candidate: CapacitorProjectCandidate) => Promise<boolean | symbol>
  select: (candidates: CapacitorProjectCandidate[]) => Promise<string | symbol>
}

export async function selectCapacitorProject(
  candidates: CapacitorProjectCandidate[],
  prompts: BuilderProjectPrompts,
): Promise<CapacitorProjectCandidate | undefined> {
  if (candidates.length === 0)
    return undefined
  if (candidates.length === 1) {
    const answer = await prompts.confirm(candidates[0])
    return answer === true ? candidates[0] : undefined
  }
  const selectedDir = await prompts.select(candidates)
  return typeof selectedDir === 'string'
    ? candidates.find(candidate => candidate.dir === selectedDir)
    : undefined
}
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
cd cli && bun run test:builder-project-discovery
```

Expected: PASS with all discovery and selection assertions.

- [ ] **Step 3: Commit the tested discovery layer**

```bash
git add cli/src/build/onboarding/project-discovery.ts cli/src/build/onboarding/project-selection.ts cli/test/test-builder-project-discovery.mjs cli/package.json bun.lock
git commit -m "feat(cli): discover Capacitor apps in workspaces"
```

### Task 4: Wire discovery into direct builder onboarding

**Files:**
- Modify: `cli/src/build/onboarding/command.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/test/test-builder-project-discovery.mjs`

- [ ] **Step 1: Write failing command-boundary assertions**

Export a pure message builder and direct-discovery decision from `command.ts`,
then test the wished-for behavior:

```js
assert.match(builderProjectNotFoundMessage(false), /npx @capgo\/cli@latest build init/)
assert.doesNotMatch(builderProjectNotFoundMessage(false), /Nx repositories/)
assert.match(builderProjectNotFoundMessage(true), /Nx repositories.*not currently supported/s)
assert.equal(shouldDiscoverBuilderProject({ enableProjectDiscovery: true }), true)
assert.equal(shouldDiscoverBuilderProject({}), false)
```

Run the focused test and confirm it fails because those exports do not exist.

- [ ] **Step 2: Add the explicit direct-entry option**

Extend `OnboardingBuilderOptions`:

```ts
/** Search exact-root package workspaces for a Capacitor app before onboarding. */
enableProjectDiscovery?: boolean
```

In `cli/src/index.ts`, set it only on the real command:

```ts
.action((options: OnboardingBuilderOptions) => onboardingBuilderCommand({
  ...options,
  enableSelfUpdate: true,
  enableProjectDiscovery: true,
}))
```

- [ ] **Step 3: Add the pre-onboarding discovery flow**

Before the existing `getConfig(true)` call, when discovery is enabled and the
current directory lacks a Capacitor config:

1. Render an Ink loading state with `Looking for a Capacitor app in this workspace...`.
2. Call `discoverCapacitorProjects(process.cwd())`.
3. Replace the loading state with the discovery result.
4. On no candidates, print `builderProjectNotFoundMessage(nxDetected)` and exit 1.
5. For one candidate, render an Ink confirmation with its relative path and
   Capacitor `appId` when available.
6. For multiple candidates, render an Ink selector with relative paths and
   Capacitor `appId` values when available.
7. Treat Ink cancellation or a rejected confirmation as a normal cancelled
   setup and return before starting logs/replay.
8. Call `process.chdir(selected.dir)` and reuse the Ink instance for the
   existing onboarding shell.

Use this pure shared wording:

```ts
export function builderProjectNotFoundMessage(nxDetected: boolean): string {
  const lines = [
    "We couldn't find a Capacitor app in this project.",
    'Run `npx @capgo/cli@latest build init` from your Capacitor app directory or from the root of a supported package-manager workspace.',
  ]
  if (nxDetected)
    lines.push('Nx repositories that do not use package-manager workspaces are not currently supported.')
  return lines.join('\n')
}
```

Keep the existing config-load error handling after the cwd handoff. Indirect
callers leave `enableProjectDiscovery` unset and retain their current behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd cli && bun run test:builder-project-discovery
```

Expected: PASS.

- [ ] **Step 5: Commit command integration**

```bash
git add cli/src/build/onboarding/command.ts cli/src/index.ts cli/test/test-builder-project-discovery.mjs
git commit -m "feat(cli): select workspace app during build init"
```

### Task 5: Verify and build the testable CLI

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run formatting/lint checks**

Run:

```bash
bun run --cwd cli lint
bun run --cwd cli typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
bun run --cwd cli test:builder-project-discovery
bun run --cwd cli test:init-monorepo-targeting
bun run --cwd cli test:build-platform-selection
```

Expected: all commands exit 0.

- [ ] **Step 3: Build the CLI**

Run from the repository root:

```bash
bun run cli:build
```

Expected: `cli/dist/index.js` is produced successfully.

- [ ] **Step 4: Smoke-test the built artifact without the TUI helper**

Run the built CLI with `--help` and confirm `build init` remains registered:

```bash
bun cli/dist/index.js build init --help
```

Expected: exit 0 and help output for `build init`. Do not launch interactive
key-helper or end-to-end TUI automation.

- [ ] **Step 5: Final diff and artifact check**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the user's pre-existing
`codedb.snapshot` change and intentional feature changes are present.

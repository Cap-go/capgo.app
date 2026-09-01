import { ref } from 'vue'

export const CICD_DEPLOY_MODES = ['prod', 'prod_preprod', 'prod_preprod_pr'] as const
export type CicdDeployMode = typeof CICD_DEPLOY_MODES[number]

export const CICD_RELEASE_KINDS = ['pr', 'preprod', 'production'] as const
export type CicdReleaseKind = typeof CICD_RELEASE_KINDS[number]

export const CICD_DOCS_URL = 'https://capgo.app/docs/getting-started/cicd-integration/'
export const CICD_GITHUB_ACTIONS_DOCS_URL = 'https://capgo.app/docs/live-updates/integrations/github-actions/'

export interface CicdSetupProgress {
  mode: CicdDeployMode | null
  releases: Partial<Record<CicdReleaseKind, boolean>>
  validated: boolean
}

const STORAGE_PREFIX = 'capgo.gettingStarted.cicd'
const progressByKey = ref(new Map<string, CicdSetupProgress>())

function emptyProgress(): CicdSetupProgress {
  return {
    mode: null,
    releases: {},
    validated: false,
  }
}

export function cicdSetupStorageKey(userId: string, appId: string) {
  return `${STORAGE_PREFIX}.${userId}.${appId}`
}

function sessionKey(userId: string, appId: string) {
  return `${userId}:${appId}`
}

function isCicdDeployMode(value: unknown): value is CicdDeployMode {
  return typeof value === 'string' && (CICD_DEPLOY_MODES as readonly string[]).includes(value)
}

function parseProgress(value: unknown): CicdSetupProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return emptyProgress()

  const raw = value as Record<string, unknown>
  const releases: CicdSetupProgress['releases'] = {}
  if (raw.releases && typeof raw.releases === 'object' && !Array.isArray(raw.releases)) {
    for (const kind of CICD_RELEASE_KINDS) {
      if ((raw.releases as Record<string, unknown>)[kind] === true)
        releases[kind] = true
    }
  }

  return {
    mode: isCicdDeployMode(raw.mode) ? raw.mode : null,
    releases,
    validated: raw.validated === true,
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  }
  catch {
    // Ignore blocked or full storage so the checklist still works in-session.
  }
}

export function requiredCicdReleases(mode: CicdDeployMode | null): CicdReleaseKind[] {
  if (mode === 'prod')
    return ['production']
  if (mode === 'prod_preprod')
    return ['preprod', 'production']
  if (mode === 'prod_preprod_pr')
    return ['pr', 'preprod', 'production']
  return []
}

export function isCicdSetupComplete(progress: CicdSetupProgress): boolean {
  if (progress.validated)
    return true
  const required = requiredCicdReleases(progress.mode)
  return required.length > 0 && required.every(kind => progress.releases[kind] === true)
}

export function loadCicdSetupProgress(userId: string, appId: string): CicdSetupProgress {
  if (!userId || !appId)
    return emptyProgress()

  const cached = progressByKey.value.get(sessionKey(userId, appId))
  if (cached)
    return cached

  if (typeof localStorage === 'undefined')
    return emptyProgress()

  const raw = readStorage(cicdSetupStorageKey(userId, appId))
  if (!raw)
    return emptyProgress()

  try {
    return parseProgress(JSON.parse(raw))
  }
  catch {
    return emptyProgress()
  }
}

export function saveCicdSetupProgress(userId: string, appId: string, progress: CicdSetupProgress) {
  if (!userId || !appId)
    return

  const next = {
    mode: progress.mode,
    releases: { ...progress.releases },
    validated: progress.validated,
  }
  writeStorage(cicdSetupStorageKey(userId, appId), JSON.stringify(next))
  const map = new Map(progressByKey.value)
  map.set(sessionKey(userId, appId), next)
  progressByKey.value = map
}

export function isCicdSetupValidated(userId: string, appId: string) {
  return loadCicdSetupProgress(userId, appId).validated
}

export function markCicdSetupValidated(userId: string, appId: string) {
  const current = loadCicdSetupProgress(userId, appId)
  saveCicdSetupProgress(userId, appId, { ...current, validated: true })
}

export function forgetCicdSetupProgress(userId: string, appId: string) {
  if (!userId || !appId)
    return

  try {
    localStorage.removeItem(cicdSetupStorageKey(userId, appId))
  }
  catch {
    // Ignore blocked storage so tests and the checklist can still reset in-memory state.
  }
  const map = new Map(progressByKey.value)
  map.delete(sessionKey(userId, appId))
  progressByKey.value = map
}

export function buildCicdAiPrompt(appId: string, mode: CicdDeployMode): string {
  const workflow = cicdWorkflowSnippet(appId, mode)
  const releases = requiredCicdReleases(mode)
    .map(kind => `- ${cicdReleaseInstruction(kind)}`)
    .join('\n')

  return `I already created my Capgo app and finished the CLI setup. Help me automate live-update uploads with GitHub Actions.

Capgo context:
- App ID: ${appId}
- Use \`npx @capgo/cli@latest\` in every command example.
- Store the Capgo API key in a GitHub Actions secret named \`CAPGO_TOKEN\`. Never commit the key.
- Docs: ${CICD_DOCS_URL}
- GitHub Actions guide: ${CICD_GITHUB_ACTIONS_DOCS_URL}

Chosen release setup:
${cicdModeInstruction(mode)}

Please:
1. Add or update \`.github/workflows/capgo-live-update.yml\` for this setup.
2. Create the Capgo channels that this workflow needs if they do not exist yet.
3. Tell me exactly which GitHub secret to add.
4. After the workflow is in the repo, help me run one CI/CD release for each target below so I can confirm it works.

Required CI/CD releases:
${releases}

Suggested workflow:

\`\`\`yaml
${workflow}
\`\`\`
`
}

export function cicdModeInstruction(mode: CicdDeployMode): string {
  if (mode === 'prod')
    return 'Deploy from `main` only, to the `production` channel.'
  if (mode === 'prod_preprod')
    return 'Deploy from `main` to `production`, and from a `preprod` branch to the `preprod` channel.'
  return 'Deploy from `main` to `production`, from a `preprod` branch to `preprod`, and upload a `pr-<number>` preview from a maintainer-approved workflow run. Fork pull requests cannot use `CAPGO_TOKEN`.'
}

export function cicdReleaseInstruction(kind: CicdReleaseKind): string {
  if (kind === 'production')
    return 'Push to `main` (or run the production job) and confirm a new bundle lands on the `production` channel.'
  if (kind === 'preprod')
    return 'Push to the `preprod` branch and confirm a new bundle lands on the `preprod` channel.'
  return 'Run the workflow for an eligible pull request (Actions → Run workflow, channel `pr-<number>`) and confirm that channel received a bundle. Fork pull requests are excluded because they cannot use `CAPGO_TOKEN`.'
}

function cicdWorkflowSnippet(appId: string, mode: CicdDeployMode): string {
  const productionJob = `  deploy-production:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx @capgo/cli@latest bundle upload ${appId} --channel production --auto-bump
        env:
          CAPGO_TOKEN: \${{ secrets.CAPGO_TOKEN }}`

  if (mode === 'prod') {
    return `name: Capgo live update
on:
  push:
    branches: [main]
jobs:
${productionJob}`
  }

  const preprodJob = `  deploy-preprod:
    if: github.ref == 'refs/heads/preprod'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx @capgo/cli@latest bundle upload ${appId} --channel preprod --auto-bump
        env:
          CAPGO_TOKEN: \${{ secrets.CAPGO_TOKEN }}`

  if (mode === 'prod_preprod') {
    return `name: Capgo live update
on:
  push:
    branches: [main, preprod]
jobs:
${productionJob}
${preprodJob}`
  }

  const prBuildJob = `  build-pr:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run build`

  const previewJob = `  deploy-preview:
    if: github.event_name == 'workflow_dispatch' && inputs.preview_channel != ''
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Upload preview
        run: |
          CHANNEL="\${{ inputs.preview_channel }}"
          npx @capgo/cli@latest channel add "$CHANNEL" ${appId} || true
          npx @capgo/cli@latest bundle upload ${appId} --channel "$CHANNEL" --auto-bump
        env:
          CAPGO_TOKEN: \${{ secrets.CAPGO_TOKEN }}`

  return `name: Capgo live update
on:
  push:
    branches: [main, preprod]
  pull_request:
  workflow_dispatch:
    inputs:
      preview_channel:
        description: Preview channel (for example pr-12). Fork pull requests cannot use CAPGO_TOKEN.
        required: false
jobs:
${productionJob}
${preprodJob}
${prBuildJob}
${previewJob}`
}

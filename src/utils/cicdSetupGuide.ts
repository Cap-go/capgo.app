// Builds the CI/CD pipelines shown by the onboarding CI/CD guide. Everything
// here is pure so each provider × strategy × product combination is unit-tested.
// Commands stay customer-facing: `npx @capgo/cli@latest`, the API key comes
// from the CAPGO_TOKEN environment variable (read by the CLI), never a flag.

export const CI_PRODUCTS = ['ota', 'builder'] as const
export const CI_STRATEGIES = ['main', 'main_preprod', 'pull_request'] as const
export const CI_PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket', 'circleci', 'other'] as const
export const CI_PLATFORMS = ['ios', 'android'] as const

export type CiProduct = typeof CI_PRODUCTS[number]
export type CiStrategy = typeof CI_STRATEGIES[number]
export type CiProvider = typeof CI_PROVIDERS[number]
export type CiPlatform = typeof CI_PLATFORMS[number]
export type CiSecretName = 'CAPGO_TOKEN' | 'CAPGO_PREVIEW_TOKEN'
/** App-scoped RBAC role bound to each CI key the guide creates. */
export type CiKeyRole = 'app_uploader' | 'app_developer' | 'app_preview' | 'app_admin'

export const DEFAULT_PRODUCTION_BRANCH = 'main'
export const DEFAULT_PREPROD_BRANCH = 'preprod'
export const DEFAULT_PRODUCTION_CHANNEL = 'production'
export const PREPROD_CHANNEL = 'preprod'
export const PREVIEW_CHANNEL_PREFIX = 'pr-'

const CLI = 'npx @capgo/cli@latest'
// Replaced by each provider's own pull request number variable.
const PR = '__CAPGO_PR_NUMBER__'

export interface CiGuideOptions {
  appId: string
  product: CiProduct
  strategy: CiStrategy
  provider: CiProvider
  /** Builder only: platforms to build. */
  platforms?: readonly CiPlatform[]
  /** Live updates only: the app's default channel. */
  productionChannel?: string
  productionBranch?: string
  preprodBranch?: string
}

export type CiTrigger
  = | { kind: 'push', branch: string }
    | { kind: 'pull_request' }
    | { kind: 'pull_request_closed' }

export interface CiJob {
  id: string
  name: string
  trigger: CiTrigger
  secret: CiSecretName
  /**
   * Every job checks out the project: the CLI loads its Capacitor config even
   * when the app id is passed. `install` skips the web build (channel cleanup).
   */
  setup: 'build' | 'install'
  /** Builder: run `npx cap sync <platform>` before requesting the build. */
  sync?: CiPlatform
  command: string
}

export interface CiKeySpec {
  secret: CiSecretName
  role: CiKeyRole
  purpose: 'release' | 'preview'
}

export interface CiPipeline {
  /** Repository path of the generated file; null when the provider has no standard file. */
  file: string | null
  language: 'yaml' | 'shell'
  content: string
  jobs: CiJob[]
  keys: CiKeySpec[]
  /** True when the pipeline deletes pull request channels after the pull request closes. */
  cleansUpPreviews: boolean
}

export const CI_PROVIDER_FILES: Record<CiProvider, string | null> = {
  github: '.github/workflows/capgo.yml',
  gitlab: '.gitlab-ci.yml',
  azure: 'azure-pipelines.yml',
  bitbucket: 'bitbucket-pipelines.yml',
  circleci: '.circleci/config.yml',
  other: null,
}

// Only GitHub and GitLab expose a "pull request closed" hook to CI.
const PROVIDERS_WITH_PREVIEW_CLEANUP = new Set<CiProvider>(['github', 'gitlab'])

const BRANCH_PATTERN = /^[\w.-]+(?:\/[\w.-]+)*$/

/** Keeps a user-typed branch name usable unquoted in every provider's YAML. */
export function normalizeCiBranch(value: string | undefined, fallback: string) {
  const branch = value?.trim() ?? ''
  return branch && branch.length <= 100 && BRANCH_PATTERN.test(branch) && !branch.includes('..') ? branch : fallback
}

/** Keeps the app's real default channel name; only a missing one falls back to production. */
export function normalizeCiChannel(value: string | null | undefined) {
  return value || DEFAULT_PRODUCTION_CHANNEL
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

/**
 * `bundle upload --channel` splits on commas and trims each name, so such a
 * channel cannot be targeted from CI. The guide asks for a rename instead of
 * silently shipping to another channel.
 */
export function isCiChannelSupported(name: string) {
  return name.length > 0 && name === name.trim() && !name.includes(',') && !CONTROL_CHARACTERS.test(name)
}

function shellArg(value: string) {
  return /^[\w./@%+=:-]+$/.test(value) ? value : `'${value.replaceAll('\'', `'\\''`)}'`
}

/** Plain YAML when it cannot be misread, otherwise a single-quoted scalar. */
function yamlScalar(value: string) {
  const plain = /^[\w$./(]/.test(value)
    && !/: |:$| #|^[\w.-]+:$/.test(value)
    && !CONTROL_CHARACTERS.test(value)
  return plain ? value : yamlQuote(value)
}

export function isCiProduct(value: unknown): value is CiProduct {
  return typeof value === 'string' && (CI_PRODUCTS as readonly string[]).includes(value)
}

export function isCiStrategy(value: unknown): value is CiStrategy {
  return typeof value === 'string' && (CI_STRATEGIES as readonly string[]).includes(value)
}

export function isCiProvider(value: unknown): value is CiProvider {
  return typeof value === 'string' && (CI_PROVIDERS as readonly string[]).includes(value)
}

export function isCiPlatform(value: unknown): value is CiPlatform {
  return typeof value === 'string' && (CI_PLATFORMS as readonly string[]).includes(value)
}

export function ciProviderCleansUpPreviews(provider: CiProvider) {
  return PROVIDERS_WITH_PREVIEW_CLEANUP.has(provider)
}

/** The keys CI needs, each limited to this one app with the smallest role that works. */
export function ciKeysFor(product: CiProduct, strategy: CiStrategy): CiKeySpec[] {
  // Building with the signing credentials stored on Capgo needs app.update_settings.
  if (product === 'builder') {
    return [
      { secret: 'CAPGO_TOKEN', role: 'app_admin', purpose: 'release' },
      // Pull request pipelines run on unprotected branches (GitLab protected
      // variables never reach them), so they get their own revocable key.
      ...(strategy === 'pull_request' ? [{ secret: 'CAPGO_PREVIEW_TOKEN', role: 'app_admin', purpose: 'preview' } as const] : []),
    ]
  }
  if (strategy === 'main_preprod') {
    // The developer role can create the preprod channel on its first upload.
    return [{ secret: 'CAPGO_TOKEN', role: 'app_developer', purpose: 'release' }]
  }
  if (strategy === 'pull_request') {
    return [
      { secret: 'CAPGO_TOKEN', role: 'app_uploader', purpose: 'release' },
      // Preview keys create pr-* channels and may only promote or delete the channels they created.
      { secret: 'CAPGO_PREVIEW_TOKEN', role: 'app_preview', purpose: 'preview' },
    ]
  }
  return [{ secret: 'CAPGO_TOKEN', role: 'app_uploader', purpose: 'release' }]
}

function resolved(options: CiGuideOptions) {
  const platforms = CI_PLATFORMS.filter(platform => (options.platforms ?? CI_PLATFORMS).includes(platform))
  return {
    ...options,
    platforms: platforms.length ? platforms : [...CI_PLATFORMS],
    productionChannel: normalizeCiChannel(options.productionChannel),
    productionBranch: normalizeCiBranch(options.productionBranch, DEFAULT_PRODUCTION_BRANCH),
    preprodBranch: normalizeCiBranch(options.preprodBranch, DEFAULT_PREPROD_BRANCH),
  }
}

function otaUpload(appId: string, channel: string) {
  return `${CLI} bundle upload ${appId} --channel ${shellArg(channel)} --auto-bump patch --fail-on-incompatible`
}

function platformLabel(platform: CiPlatform) {
  return platform === 'ios' ? 'iOS' : 'Android'
}

export function buildCiJobs(input: CiGuideOptions): CiJob[] {
  const options = resolved(input)
  const { appId, strategy, productionBranch, preprodBranch } = options
  const production: CiTrigger = { kind: 'push', branch: productionBranch }
  const preprod: CiTrigger = { kind: 'push', branch: preprodBranch }

  if (options.product === 'ota') {
    const jobs: CiJob[] = [{
      id: 'production',
      name: `Upload live update to ${options.productionChannel}`,
      trigger: production,
      secret: 'CAPGO_TOKEN',
      setup: 'build',
      command: otaUpload(appId, options.productionChannel),
    }]
    if (strategy === 'main_preprod') {
      jobs.push({
        id: 'preprod',
        name: `Upload live update to ${PREPROD_CHANNEL}`,
        trigger: preprod,
        secret: 'CAPGO_TOKEN',
        setup: 'build',
        command: otaUpload(appId, PREPROD_CHANNEL),
      })
    }
    if (strategy === 'pull_request') {
      jobs.push({
        id: 'preview',
        name: 'Upload pull request preview',
        trigger: { kind: 'pull_request' },
        secret: 'CAPGO_PREVIEW_TOKEN',
        setup: 'build',
        command: otaUpload(appId, `${PREVIEW_CHANNEL_PREFIX}${PR}`),
      })
      if (ciProviderCleansUpPreviews(options.provider)) {
        jobs.push({
          id: 'preview-cleanup',
          name: 'Delete pull request preview',
          trigger: { kind: 'pull_request_closed' },
          secret: 'CAPGO_PREVIEW_TOKEN',
          setup: 'install',
          command: `${CLI} channel delete ${PREVIEW_CHANNEL_PREFIX}${PR} ${appId} --delete-bundle --success-if-not-found`,
        })
      }
    }
    return jobs
  }

  const buildCommand = (platform: CiPlatform) => `${CLI} build request ${appId} --platform ${platform} --use-stored-credentials`
  // Release jobs first, so every provider lists the production branch first.
  const releases = options.platforms.map((platform): CiJob => ({
    id: `${platform}-release`,
    // With a preprod branch for testers, main is the store release.
    name: strategy === 'main_preprod'
      ? `Build ${platformLabel(platform)} and submit for store review`
      : `Build ${platformLabel(platform)} release`,
    trigger: production,
    secret: 'CAPGO_TOKEN',
    setup: 'build',
    sync: platform,
    command: strategy === 'main_preprod' ? `${buildCommand(platform)} --submit-to-store-review` : buildCommand(platform),
  }))
  if (strategy === 'main_preprod') {
    return [...releases, ...options.platforms.map((platform): CiJob => ({
      id: `${platform}-preprod`,
      name: `Build ${platformLabel(platform)} for testers`,
      trigger: preprod,
      secret: 'CAPGO_TOKEN',
      setup: 'build',
      sync: platform,
      command: buildCommand(platform),
    }))]
  }
  if (strategy === 'pull_request') {
    return [...releases, ...options.platforms.map((platform): CiJob => ({
      id: `${platform}-preview`,
      name: `Build ${platformLabel(platform)} pull request preview`,
      trigger: { kind: 'pull_request' },
      secret: 'CAPGO_PREVIEW_TOKEN',
      setup: 'build',
      sync: platform,
      // Android previews are installable debug APK links; iOS previews go to TestFlight.
      command: platform === 'android'
        ? `${buildCommand(platform)} --build-mode debug --no-playstore-upload --output-upload`
        : buildCommand(platform),
    }))]
  }
  return releases
}

function sameTrigger(a: CiTrigger, b: CiTrigger) {
  return a.kind === b.kind && (a.kind !== 'push' || b.kind !== 'push' || a.branch === b.branch)
}

function groupByTrigger(jobs: CiJob[]) {
  const groups: Array<{ trigger: CiTrigger, jobs: CiJob[] }> = []
  for (const job of jobs) {
    const group = groups.find(entry => sameTrigger(entry.trigger, job.trigger))
    if (group)
      group.jobs.push(job)
    else
      groups.push({ trigger: job.trigger, jobs: [job] })
  }
  return groups
}

function pushBranches(jobs: CiJob[]) {
  return [...new Set(jobs.flatMap(job => job.trigger.kind === 'push' ? [job.trigger.branch] : []))]
}

function withPr(command: string, variable: string) {
  return command.replaceAll(PR, variable)
}

// Outside GitHub and Azure, secrets are plain environment variables: the
// preview key is passed only to the command that needs it.
function shellCommand(job: CiJob, prVariable: string) {
  const command = withPr(job.command, prVariable)
  return job.secret === 'CAPGO_TOKEN' ? command : `CAPGO_TOKEN="$${job.secret}" ${command}`
}

function setupCommands(job: CiJob) {
  return job.setup === 'build'
    ? ['npm ci', 'npm run build', ...(job.sync ? [`npx cap sync ${job.sync}`] : [])]
    : ['npm ci']
}

function yamlQuote(value: string) {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function renderGithub(jobs: CiJob[], workflowName: string) {
  const branches = pushBranches(jobs)
  const hasPr = jobs.some(job => job.trigger.kind !== 'push')
  const hasCleanup = jobs.some(job => job.trigger.kind === 'pull_request_closed')
  const lines = [`name: ${workflowName}`, '', 'on:']
  if (branches.length)
    lines.push('  push:', `    branches: [${branches.join(', ')}]`)
  if (hasPr) {
    lines.push('  pull_request:')
    if (hasCleanup)
      lines.push('    types: [opened, synchronize, reopened, closed]')
  }
  lines.push('', 'jobs:')
  // Fork pull requests get no secrets, so they skip instead of failing.
  const sameRepo = 'github.event.pull_request.head.repo.full_name == github.repository'
  jobs.forEach((job, index) => {
    let condition: string
    if (job.trigger.kind === 'push')
      condition = `github.event_name == 'push' && github.ref_name == '${job.trigger.branch}'`
    else if (job.trigger.kind === 'pull_request')
      condition = `github.event_name == 'pull_request' && github.event.action != 'closed' && ${sameRepo}`
    else
      condition = `github.event_name == 'pull_request' && github.event.action == 'closed' && ${sameRepo}`
    if (index > 0)
      lines.push('')
    lines.push(
      `  ${job.id}:`,
      `    name: ${yamlScalar(job.name)}`,
      `    if: ${condition}`,
      '    runs-on: ubuntu-latest',
      '    steps:',
    )
    lines.push('      - uses: actions/checkout@v6')
    // A closed pull request can lose its merge ref; the base branch always has the config.
    if (job.trigger.kind === 'pull_request_closed')
      lines.push('        with:', `          ref: \${{ github.event.pull_request.base.ref }}`)
    lines.push(
      '      - uses: actions/setup-node@v6',
      '        with:',
      '          node-version: 24',
      '          cache: npm',
    )
    for (const command of setupCommands(job))
      lines.push(`      - run: ${command}`)
    lines.push(
      `      - run: ${yamlScalar(withPr(job.command, `\${{ github.event.pull_request.number }}`))}`,
      '        env:',
      `          CAPGO_TOKEN: \${{ secrets.${job.secret} }}`,
    )
  })
  return lines.join('\n')
}

function renderGitlab(jobs: CiJob[]) {
  const lines = ['default:', '  image: node:24']
  const prVariable = '$CI_MERGE_REQUEST_IID'
  const environment = `capgo/${PREVIEW_CHANNEL_PREFIX}$CI_MERGE_REQUEST_IID`
  const hasCleanup = jobs.some(job => job.trigger.kind === 'pull_request_closed')
  for (const job of jobs) {
    lines.push('', `capgo-${job.id}:`, '  rules:')
    if (job.trigger.kind === 'push') {
      lines.push(`    - if: $CI_COMMIT_BRANCH == "${job.trigger.branch}"`)
    }
    else if (job.trigger.kind === 'pull_request') {
      lines.push('    - if: $CI_PIPELINE_SOURCE == "merge_request_event"')
      if (hasCleanup) {
        lines.push(
          '  environment:',
          `    name: ${environment}`,
          '    on_stop: capgo-preview-cleanup',
          '    auto_stop_in: 2 weeks',
        )
      }
    }
    else {
      // GitLab runs this stop job when the merge request is merged or closed. It
      // keeps the default checkout: merge request refs outlive deleted branches.
      lines.push(
        '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
        '      when: manual',
        '  allow_failure: true',
        '  environment:',
        `    name: ${environment}`,
        '    action: stop',
      )
    }
    lines.push('  script:')
    for (const command of [...setupCommands(job), shellCommand(job, prVariable)])
      lines.push(`    - ${yamlScalar(command)}`)
  }
  return lines.join('\n')
}

function renderAzure(jobs: CiJob[]) {
  const branches = pushBranches(jobs)
  const hasPr = jobs.some(job => job.trigger.kind === 'pull_request')
  const lines = ['trigger:', '  branches:', '    include:']
  for (const branch of branches)
    lines.push(`      - ${branch}`)
  if (hasPr)
    lines.push('', 'pr:', '  branches:', '    include:', `      - ${yamlQuote('*')}`)
  else
    lines.push('', 'pr: none')
  lines.push(
    '',
    'variables:',
    '  - group: capgo',
    '',
    'pool:',
    '  vmImage: ubuntu-latest',
    '',
    'jobs:',
  )
  jobs.forEach((job, index) => {
    const condition = job.trigger.kind === 'push'
      ? `and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/${job.trigger.branch}'), ne(variables['Build.Reason'], 'PullRequest'))`
      : `and(succeeded(), eq(variables['Build.Reason'], 'PullRequest'))`
    if (index > 0)
      lines.push('')
    lines.push(
      `  - job: ${job.id.replaceAll('-', '_')}`,
      `    displayName: ${yamlScalar(job.name)}`,
      `    condition: ${condition}`,
      '    steps:',
      '      - task: NodeTool@0',
      '        inputs:',
      `          versionSpec: ${yamlQuote('24.x')}`,
    )
    for (const command of setupCommands(job))
      lines.push(`      - script: ${command}`)
    lines.push(
      `      - script: ${yamlScalar(withPr(job.command, '$(System.PullRequest.PullRequestId)'))}`,
      `        displayName: ${yamlScalar(job.name)}`,
      '        env:',
      `          CAPGO_TOKEN: $(${job.secret})`,
    )
  })
  return lines.join('\n')
}

function renderBitbucketStep(job: CiJob, indent: string) {
  const lines = [
    `${indent}- step:`,
    `${indent}    name: ${yamlScalar(job.name)}`,
    `${indent}    caches:`,
    `${indent}      - node`,
    `${indent}    script:`,
  ]
  for (const command of [...setupCommands(job), shellCommand(job, '$BITBUCKET_PR_ID')])
    lines.push(`${indent}      - ${yamlScalar(command)}`)
  return lines
}

function renderBitbucket(jobs: CiJob[]) {
  const lines = ['image: node:24', '', 'pipelines:']
  const groups = groupByTrigger(jobs)
  const branchGroups = groups.filter(group => group.trigger.kind === 'push')
  const prGroups = groups.filter(group => group.trigger.kind === 'pull_request')
  const renderGroup = (group: typeof groups[number], indent: string) => {
    if (group.jobs.length === 1)
      return renderBitbucketStep(group.jobs[0]!, indent)
    return [`${indent}- parallel:`, ...group.jobs.flatMap(job => renderBitbucketStep(job, `${indent}    `))]
  }
  if (branchGroups.length) {
    lines.push('  branches:')
    for (const group of branchGroups) {
      lines.push(`    ${group.trigger.kind === 'push' ? group.trigger.branch : ''}:`)
      lines.push(...renderGroup(group, '      '))
    }
  }
  if (prGroups.length) {
    lines.push('  pull-requests:', `    ${yamlQuote('**')}:`)
    for (const group of prGroups)
      lines.push(...renderGroup(group, '      '))
  }
  return lines.join('\n')
}

function renderCircleci(jobs: CiJob[]) {
  const lines = [
    'version: 2.1',
    '',
    'executors:',
    '  node:',
    '    docker:',
    '      - image: cimg/node:lts',
    '',
    'jobs:',
  ]
  const prVariable = `\${CIRCLE_PULL_REQUEST##*/}`
  jobs.forEach((job, index) => {
    if (index > 0)
      lines.push('')
    lines.push(`  ${job.id}:`, '    executor: node', '    steps:')
    if (job.trigger.kind === 'pull_request') {
      lines.push(
        '      - run:',
        '          name: Skip branches without a pull request',
        '          command: if [ -z "$CIRCLE_PULL_REQUEST" ]; then circleci-agent step halt; fi',
      )
    }
    lines.push('      - checkout')
    for (const command of setupCommands(job))
      lines.push(`      - run: ${command}`)
    lines.push(
      '      - run:',
      `          name: ${yamlScalar(job.name)}`,
      `          command: ${yamlScalar(shellCommand(job, prVariable))}`,
    )
  })
  const releaseBranches = pushBranches(jobs)
  lines.push('', 'workflows:', '  capgo:', '    jobs:')
  for (const job of jobs) {
    lines.push(`      - ${job.id}:`, '          filters:', '            branches:')
    if (job.trigger.kind === 'push')
      lines.push(`              only: ${job.trigger.branch}`)
    else
      lines.push(`              ignore: [${releaseBranches.join(', ')}]`)
  }
  return lines.join('\n')
}

function renderOther(jobs: CiJob[]) {
  const lines: string[] = []
  for (const group of groupByTrigger(jobs)) {
    if (lines.length)
      lines.push('')
    if (group.trigger.kind === 'push')
      lines.push(`# On every push to ${group.trigger.branch}`)
    else if (group.trigger.kind === 'pull_request')
      lines.push('# On every pull request update (set PR_NUMBER to the pull request number)')
    else
      lines.push('# When a pull request is merged or closed')
    group.jobs.forEach((job, index) => {
      if (group.jobs.length > 1)
        lines.push(...(index > 0 ? [''] : []), `# ${job.name}`)
      lines.push(...setupCommands(job), shellCommand(job, '$PR_NUMBER'))
    })
  }
  return lines.join('\n')
}

export function buildCiPipeline(input: CiGuideOptions): CiPipeline {
  const jobs = buildCiJobs(input)
  const workflowName = input.product === 'ota' ? 'Capgo live updates' : 'Capgo native builds'
  const renderers: Record<CiProvider, () => string> = {
    github: () => renderGithub(jobs, workflowName),
    gitlab: () => renderGitlab(jobs),
    azure: () => renderAzure(jobs),
    bitbucket: () => renderBitbucket(jobs),
    circleci: () => renderCircleci(jobs),
    other: () => renderOther(jobs),
  }
  return {
    file: CI_PROVIDER_FILES[input.provider],
    language: input.provider === 'other' ? 'shell' : 'yaml',
    content: `${renderers[input.provider]()}\n`,
    jobs,
    keys: ciKeysFor(input.product, input.strategy),
    cleansUpPreviews: jobs.some(job => job.trigger.kind === 'pull_request_closed'),
  }
}

/** `gh secret set` reads the value from stdin, so the key never lands in shell history. */
export function githubSecretCommand(secret: CiSecretName) {
  return `gh secret set ${secret}`
}

/** Builder: store this machine's signing credentials on Capgo so CI only needs CAPGO_TOKEN. */
export function builderCredentialsPushCommand(appId: string, platform: CiPlatform) {
  return `${CLI} build credentials push ${appId} --platform ${platform}`
}

export function previewCleanupCommand(appId: string) {
  return `${CLI} channel delete ${PREVIEW_CHANNEL_PREFIX}<number> ${appId} --delete-bundle`
}

export interface CiGuideSelection {
  product: CiProduct
  strategy: CiStrategy
  provider: CiProvider | null
  platforms: CiPlatform[]
  productionBranch: string
  preprodBranch: string
}

function selectionKey(userId: string | null | undefined, appId: string) {
  return userId && appId ? `capgo:cicd-guide:${encodeURIComponent(userId)}:${encodeURIComponent(appId)}` : null
}

/** Browser-local, like the checklist path preference: the answers are a convenience, not state. */
export function loadCiGuideSelection(userId: string | null | undefined, appId: string): Partial<CiGuideSelection> {
  const key = selectionKey(userId, appId)
  try {
    const saved = JSON.parse(key ? localStorage.getItem(key) ?? '{}' : '{}') as Record<string, unknown>
    if (!saved || typeof saved !== 'object' || Array.isArray(saved))
      return {}
    const platforms = Array.isArray(saved.platforms) ? saved.platforms.filter(isCiPlatform) : []
    return {
      ...(isCiProduct(saved.product) ? { product: saved.product } : {}),
      ...(isCiStrategy(saved.strategy) ? { strategy: saved.strategy } : {}),
      ...(isCiProvider(saved.provider) ? { provider: saved.provider } : {}),
      ...(platforms.length ? { platforms: [...new Set(platforms)] } : {}),
      ...(typeof saved.productionBranch === 'string' ? { productionBranch: normalizeCiBranch(saved.productionBranch, DEFAULT_PRODUCTION_BRANCH) } : {}),
      ...(typeof saved.preprodBranch === 'string' ? { preprodBranch: normalizeCiBranch(saved.preprodBranch, DEFAULT_PREPROD_BRANCH) } : {}),
    }
  }
  catch {
    return {}
  }
}

export function saveCiGuideSelection(userId: string | null | undefined, appId: string, selection: CiGuideSelection) {
  const key = selectionKey(userId, appId)
  try {
    if (key)
      localStorage.setItem(key, JSON.stringify(selection))
  }
  catch {
    // The guide still works when browser storage is blocked.
  }
}

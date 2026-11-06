// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  buildCiJobs,
  buildCiPipeline,
  builderCredentialsPushCommand,
  CI_PRODUCTS,
  CI_PROVIDERS,
  CI_STRATEGIES,
  ciKeysFor,
  isCiChannelSupported,
  loadCiGuideSelection,
  normalizeCiBranch,
  normalizeCiChannel,
  saveCiGuideSelection,
} from '../src/utils/cicdSetupGuide'

const appId = 'com.example.app'
const base = { appId, productionChannel: 'production' } as const

describe('CI/CD guide pipelines', () => {
  it('renders valid YAML for every product, strategy and provider', () => {
    for (const product of CI_PRODUCTS) {
      for (const strategy of CI_STRATEGIES) {
        for (const provider of CI_PROVIDERS) {
          const pipeline = buildCiPipeline({ ...base, product, strategy, provider })
          expect(pipeline.content.endsWith('\n')).toBe(true)
          expect(pipeline.content).not.toContain('__CAPGO_PR_NUMBER__')
          expect(pipeline.content).not.toContain('--apikey')
          if (provider === 'other') {
            expect(pipeline.file).toBeNull()
            expect(pipeline.language).toBe('shell')
            continue
          }
          expect(pipeline.language).toBe('yaml')
          expect(() => parse(pipeline.content), `${product}/${strategy}/${provider}`).not.toThrow()
        }
      }
    }
  })

  it('ships live updates from main to the default channel on GitHub', () => {
    const pipeline = buildCiPipeline({ ...base, productionChannel: 'stable', product: 'ota', strategy: 'main', provider: 'github' })
    const workflow = parse(pipeline.content)
    expect(pipeline.file).toBe('.github/workflows/capgo.yml')
    expect(workflow.on).toEqual({ push: { branches: ['main'] } })
    const steps = workflow.jobs.production.steps
    expect(steps.map((step: { run?: string }) => step.run).filter(Boolean)).toEqual([
      'npm ci',
      'npm run build',
      'npx @capgo/cli@latest bundle upload com.example.app --channel stable --auto-bump patch --fail-on-incompatible',
    ])
    expect(steps.at(-1).env).toEqual({ CAPGO_TOKEN: '${{ secrets.CAPGO_TOKEN }}' })
    expect(pipeline.keys).toEqual([{ secret: 'CAPGO_TOKEN', role: 'app_uploader', purpose: 'release' }])
  })

  it('routes main and preprod to their own channels with custom branch names', () => {
    const jobs = buildCiJobs({ ...base, product: 'ota', strategy: 'main_preprod', provider: 'gitlab', productionBranch: 'master', preprodBranch: 'release/staging' })
    expect(jobs.map(job => [job.trigger, job.command])).toEqual([
      [{ kind: 'push', branch: 'master' }, expect.stringContaining('--channel production ')],
      [{ kind: 'push', branch: 'release/staging' }, expect.stringContaining('--channel preprod ')],
    ])
    const gitlab = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main_preprod', provider: 'gitlab', productionBranch: 'master', preprodBranch: 'release/staging' }).content)
    expect(gitlab['capgo-preprod'].rules).toEqual([{ if: '$CI_COMMIT_BRANCH == "release/staging"' }])
    expect(ciKeysFor('ota', 'main_preprod')).toEqual([{ secret: 'CAPGO_TOKEN', role: 'app_developer', purpose: 'release' }])
  })

  it('uses a separate preview key for pull requests and cleans up on GitHub', () => {
    const pipeline = buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'github' })
    const workflow = parse(pipeline.content)
    expect(workflow.on.pull_request.types).toContain('closed')
    expect(workflow.jobs.preview.steps.at(-1)).toEqual({
      run: 'npx @capgo/cli@latest bundle upload com.example.app --channel pr-${{ github.event.pull_request.number }} --auto-bump patch --fail-on-incompatible',
      env: { CAPGO_TOKEN: '${{ secrets.CAPGO_PREVIEW_TOKEN }}' },
    })
    expect(workflow.jobs['preview-cleanup'].steps.map((step: { uses?: string, run?: string }) => step.uses ?? step.run)).toEqual([
      'actions/checkout@v6',
      'actions/setup-node@v6',
      'npm ci',
      'npx @capgo/cli@latest channel delete pr-${{ github.event.pull_request.number }} com.example.app --delete-bundle --success-if-not-found',
    ])
    expect(workflow.jobs['preview-cleanup'].steps[0].with).toEqual({ ref: '${{ github.event.pull_request.base.ref }}' })
    expect(workflow.jobs.preview.steps[0].with).toBeUndefined()
    // Fork pull requests have no secrets, so their jobs skip.
    expect(workflow.jobs.preview.if).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(pipeline.cleansUpPreviews).toBe(true)
    expect(pipeline.keys.map(key => [key.secret, key.role])).toEqual([
      ['CAPGO_TOKEN', 'app_uploader'],
      ['CAPGO_PREVIEW_TOKEN', 'app_preview'],
    ])
  })

  it('stops GitLab preview environments to delete the channel', () => {
    const gitlab = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'gitlab' }).content)
    expect(gitlab['capgo-preview'].environment).toEqual({
      name: 'capgo/pr-$CI_MERGE_REQUEST_IID',
      on_stop: 'capgo-preview-cleanup',
      auto_stop_in: '2 weeks',
    })
    expect(gitlab['capgo-preview-cleanup'].environment.action).toBe('stop')
    // The CLI loads the Capacitor config, so cleanup keeps the checkout and installs dependencies.
    expect(gitlab['capgo-preview-cleanup'].variables).toBeUndefined()
    expect(gitlab['capgo-preview-cleanup'].script).toEqual([
      'npm ci',
      'CAPGO_TOKEN="$CAPGO_PREVIEW_TOKEN" npx @capgo/cli@latest channel delete pr-$CI_MERGE_REQUEST_IID com.example.app --delete-bundle --success-if-not-found',
    ])
  })

  it('uses each provider\'s pull request number and keeps cleanup manual where CI has no close event', () => {
    const expected = {
      azure: 'pr-$(System.PullRequest.PullRequestId)',
      bitbucket: 'pr-$BITBUCKET_PR_ID',
      circleci: 'pr-${CIRCLE_PULL_REQUEST##*/}',
      other: 'pr-$PR_NUMBER',
    } as const
    for (const [provider, channel] of Object.entries(expected)) {
      const pipeline = buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: provider as keyof typeof expected })
      expect(pipeline.content).toContain(`--channel ${channel} `)
      expect(pipeline.cleansUpPreviews).toBe(false)
      expect(pipeline.content).not.toContain('channel delete')
    }
  })

  it('maps Azure secrets from the capgo variable group into each step', () => {
    const azure = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'azure' }).content)
    expect(azure.variables).toEqual([{ group: 'capgo' }])
    expect(azure.jobs.map((job: { job: string }) => job.job)).toEqual(['production', 'preview'])
    expect(azure.jobs[0].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '$(CAPGO_TOKEN)' })
    expect(azure.jobs[1].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '$(CAPGO_PREVIEW_TOKEN)' })
    expect(parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'azure' }).content).pr).toBe('none')
  })

  it('builds each selected native platform with stored credentials', () => {
    const pipeline = buildCiPipeline({ ...base, product: 'builder', strategy: 'main', provider: 'github', platforms: ['android'] })
    const workflow = parse(pipeline.content)
    expect(Object.keys(workflow.jobs)).toEqual(['android-release'])
    expect(workflow.jobs['android-release'].steps.map((step: { run?: string }) => step.run).filter(Boolean)).toEqual([
      'npm ci',
      'npm run build',
      'npx cap sync android',
      'npx @capgo/cli@latest build request com.example.app --platform android --use-stored-credentials',
    ])
    expect(pipeline.keys).toEqual([{ secret: 'CAPGO_TOKEN', role: 'app_admin', purpose: 'release' }])
  })

  it('submits main for store review when preprod ships to testers', () => {
    const jobs = buildCiJobs({ ...base, product: 'builder', strategy: 'main_preprod', provider: 'bitbucket' })
    expect(jobs.map(job => job.id)).toEqual(['ios-release', 'android-release', 'ios-preprod', 'android-preprod'])
    expect(jobs.filter(job => job.command.includes('--submit-to-store-review')).map(job => job.id)).toEqual(['ios-release', 'android-release'])
    const bitbucket = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'main_preprod', provider: 'bitbucket' }).content)
    expect(Object.keys(bitbucket.pipelines.branches)).toEqual(['main', 'preprod'])
    expect(bitbucket.pipelines.branches.main[0].parallel).toHaveLength(2)
  })

  it('builds installable Android previews and TestFlight iOS previews for pull requests', () => {
    const jobs = buildCiJobs({ ...base, product: 'builder', strategy: 'pull_request', provider: 'circleci' })
    expect(jobs.find(job => job.id === 'android-preview')?.command).toBe('npx @capgo/cli@latest build request com.example.app --platform android --use-stored-credentials --build-mode debug --no-playstore-upload --output-upload')
    expect(jobs.find(job => job.id === 'ios-preview')?.command).toBe('npx @capgo/cli@latest build request com.example.app --platform ios --use-stored-credentials')
    // Pull request pipelines run on unprotected branches, so previews get their own key.
    expect(jobs.filter(job => job.trigger.kind === 'pull_request').map(job => job.secret)).toEqual(['CAPGO_PREVIEW_TOKEN', 'CAPGO_PREVIEW_TOKEN'])
    expect(jobs.filter(job => job.trigger.kind === 'push').map(job => job.secret)).toEqual(['CAPGO_TOKEN', 'CAPGO_TOKEN'])
    expect(ciKeysFor('builder', 'pull_request')).toEqual([
      { secret: 'CAPGO_TOKEN', role: 'app_admin', purpose: 'release' },
      { secret: 'CAPGO_PREVIEW_TOKEN', role: 'app_admin', purpose: 'preview' },
    ])
    const gitlab = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'gitlab', platforms: ['android'] }).content)
    expect(gitlab['capgo-android-preview'].script.at(-1)).toBe('CAPGO_TOKEN="$CAPGO_PREVIEW_TOKEN" npx @capgo/cli@latest build request com.example.app --platform android --use-stored-credentials --build-mode debug --no-playstore-upload --output-upload')
    const circleci = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'circleci' }).content)
    expect(circleci.workflows.capgo.jobs).toContainEqual({ 'android-preview': { filters: { branches: { ignore: ['main'] } } } })
  })

  it('rejects branch and channel names that would break the YAML', () => {
    expect(normalizeCiBranch(' develop ', 'main')).toBe('develop')
    expect(normalizeCiBranch('feature/a.b_c-1', 'main')).toBe('feature/a.b_c-1')
    for (const value of ['', 'a b', 'a: b', '\'quoted\'', 'x\ny', '../up', 'a//b', '#hash', '*'])
      expect(normalizeCiBranch(value, 'main')).toBe('main')
    // The app's real default channel is kept, whatever its name; only a missing one falls back.
    expect(normalizeCiChannel('beta-1')).toBe('beta-1')
    expect(normalizeCiChannel('Live app / v2')).toBe('Live app / v2')
    expect(normalizeCiChannel(null)).toBe('production')
    expect(normalizeCiChannel('')).toBe('production')
  })

  it('quotes unusual default channel names instead of replacing them', () => {
    const channel = 'Store: it\'s #1 / ${HOME}'
    const shell = `'Store: it'\\''s #1 / \${HOME}'`
    const expected = `npx @capgo/cli@latest bundle upload com.example.app --channel ${shell} --auto-bump patch --fail-on-incompatible`
    const commands = {
      github: (yaml: any) => yaml.jobs.production.steps.at(-1).run,
      gitlab: (yaml: any) => yaml['capgo-production'].script.at(-1),
      azure: (yaml: any) => yaml.jobs[0].steps.at(-1).script,
      bitbucket: (yaml: any) => yaml.pipelines.branches.main[0].step.script.at(-1),
      circleci: (yaml: any) => yaml.jobs.production.steps.at(-1).run.command,
    } as const
    for (const [provider, read] of Object.entries(commands)) {
      const pipeline = buildCiPipeline({ ...base, productionChannel: channel, product: 'ota', strategy: 'main', provider: provider as keyof typeof commands })
      expect(read(parse(pipeline.content)), provider).toBe(expected)
    }
    expect(buildCiPipeline({ ...base, productionChannel: channel, product: 'ota', strategy: 'main', provider: 'other' }).content).toContain(expected)
    expect(parse(buildCiPipeline({ ...base, productionChannel: channel, product: 'ota', strategy: 'main', provider: 'github' }).content).jobs.production.name).toBe(`Upload live update to ${channel}`)
  })

  it('flags channel names the CLI channel option cannot target', () => {
    expect(isCiChannelSupported('production')).toBe(true)
    expect(isCiChannelSupported('Live app / v2')).toBe(true)
    for (const name of ['', 'a,b', ' production', 'production ', 'prod\nuction', 'prod\tuction'])
      expect(isCiChannelSupported(name), JSON.stringify(name)).toBe(false)
  })

  it('prints the credentials push command for each platform', () => {
    expect(builderCredentialsPushCommand(appId, 'ios')).toBe('npx @capgo/cli@latest build credentials push com.example.app --platform ios')
  })
})

describe('CI/CD guide selection storage', () => {
  beforeEach(() => localStorage.clear())

  it('keeps valid answers per user and app', () => {
    saveCiGuideSelection('user-1', appId, { product: 'builder', strategy: 'pull_request', provider: 'gitlab', platforms: ['ios'], productionBranch: 'master', preprodBranch: 'preprod' })
    expect(loadCiGuideSelection('user-1', appId)).toEqual({ product: 'builder', strategy: 'pull_request', provider: 'gitlab', platforms: ['ios'], productionBranch: 'master', preprodBranch: 'preprod' })
    expect(loadCiGuideSelection('user-2', appId)).toEqual({})
    expect(loadCiGuideSelection(null, appId)).toEqual({})
  })

  it('drops unknown or malformed values', () => {
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, JSON.stringify({ product: 'web', strategy: 'nightly', provider: 'jenkins', platforms: ['ios', 'windows', 'ios'], productionBranch: 'a b' }))
    expect(loadCiGuideSelection('user-1', appId)).toEqual({ platforms: ['ios'], productionBranch: 'main' })
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, '{not json')
    expect(loadCiGuideSelection('user-1', appId)).toEqual({})
  })
})

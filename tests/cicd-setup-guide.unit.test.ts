// @vitest-environment happy-dom
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  buildCiJobs,
  buildCiPipeline,
  BUILDER_PREVIEW_SCOPE,
  builderCredentialsPushCommand,
  CI_ENCRYPTION_SECRET,
  CI_PRODUCTS,
  CI_PROVIDERS,
  CI_RESTORE_KEY_COMMAND,
  CI_STRATEGIES,
  ciKeysFor,
  encryptionSecretCommand,
  githubSecretCommand,
  isCiChannelSupported,
  loadCiGuideSelection,
  normalizeCiBranch,
  normalizeCiChannel,
  normalizeCiChannels,
  saveCiGuideSelection,
} from '../src/utils/cicdSetupGuide'

const appId = 'com.example.app'
const base = { appId, productionChannels: ['production'] } as const

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
          if (provider === 'github')
            expect(parse(pipeline.content).permissions).toEqual({ contents: 'read' })
        }
      }
    }
  })

  it('ships live updates from main to the default channel on GitHub', () => {
    const pipeline = buildCiPipeline({ ...base, productionChannels: ['stable'], product: 'ota', strategy: 'main', provider: 'github' })
    const workflow = parse(pipeline.content)
    expect(pipeline.file).toBe('.github/workflows/capgo.yml')
    expect(workflow.on).toEqual({ push: { branches: ['main'] } })
    expect(pipeline.content).toContain("branches: ['main']")
    const steps = workflow.jobs.production.steps
    expect(steps.filter((step: { id?: string }) => step.id !== 'release_head').map((step: { run?: string }) => step.run).filter(Boolean)).toEqual([
      'npm ci',
      'npm run build',
      'npx @capgo/cli@latest bundle upload com.example.app --channel stable --auto-bump patch --fail-on-incompatible',
    ])
    expect(steps.at(-1).env).toEqual({ CAPGO_TOKEN: '${{ secrets.CAPGO_TOKEN }}' })
    expect(pipeline.keys).toEqual([{ secret: 'CAPGO_TOKEN', role: 'app_uploader', purpose: 'release' }])
  })

  it('rejects production and preproduction branches that normalize to the same name', () => {
    for (const product of CI_PRODUCTS) {
      expect(() => buildCiPipeline({ ...base, product, strategy: 'main_preprod', provider: 'github', productionBranch: ' main ', preprodBranch: 'main' })).toThrow('branches must be different')
    }
  })

  it('keeps release credentials in provider scopes that can restrict branch access', () => {
    for (const product of CI_PRODUCTS) {
      const options = { ...base, product, strategy: 'pull_request' } as const
      const github = parse(buildCiPipeline({ ...options, provider: 'github' }).content)
      for (const [id, job] of Object.entries<{ environment?: string }>(github.jobs))
        expect(job.environment, id).toBe(id.includes('preview') ? product === 'builder' ? BUILDER_PREVIEW_SCOPE : undefined : 'capgo-release')
      const bitbucket = parse(buildCiPipeline({ ...options, provider: 'bitbucket', platforms: ['ios'] }).content)
      expect(bitbucket.pipelines.branches.main[0].step.environment).toBe('capgo-release')
      if (product === 'ota')
        expect(bitbucket.pipelines['pull-requests']['**'][0].step.environment).toBe('capgo-preview')
      else
        expect(bitbucket.pipelines['pull-requests']['**'][1].stage.environment).toBe(BUILDER_PREVIEW_SCOPE)
      const circleci = parse(buildCiPipeline({ ...options, provider: 'circleci' }).content)
      for (const entry of circleci.workflows.capgo.jobs) {
        const [id, config] = Object.entries<{ context?: string, type?: string }>(entry)[0]!
        if (config.type === 'approval') {
          expect(config.context).toBeUndefined()
          continue
        }
        const previewScope = product === 'builder' ? BUILDER_PREVIEW_SCOPE : 'capgo-preview'
        expect(config.context, id).toBe(id.includes('preview') ? previewScope : 'capgo-release')
      }
      const testerJobs = buildCiJobs({ ...options, strategy: 'main', provider: 'github' })
      if (product === 'builder')
        expect(testerJobs.every(job => job.env?.CAPGO_STORE_SUBMIT_REVIEW === 'false')).toBe(true)
    }
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

  it('keeps tester uploads distinct from every production default across providers', () => {
    for (const provider of CI_PROVIDERS) {
      const options = { ...base, product: 'ota', strategy: 'main_preprod', provider, productionChannels: ['ios', 'preprod'] } as const
      expect(() => buildCiPipeline(options)).toThrow('different from every production default')
      expect(() => buildCiPipeline({ ...options, preprodChannel: 'ios' })).toThrow('different from every production default')
      for (const invalid of ['', ' a', 'a ', 'a,b', 'a\nb'])
        expect(() => buildCiPipeline({ ...options, preprodChannel: invalid })).toThrow('supported by the CLI')
      const pipeline = buildCiPipeline({ ...options, preprodChannel: 'ci-testers' })
      expect(pipeline.jobs.find(job => job.id === 'production')?.command).toContain('--channel ios,preprod ')
      expect(pipeline.jobs.find(job => job.id === 'preprod')?.command).toContain('--channel ci-testers ')
      // Branch-only releases and native builds do not use this tester channel.
      expect(() => buildCiPipeline({ ...options, strategy: 'main' })).not.toThrow()
      expect(() => buildCiPipeline({ ...options, product: 'builder' })).not.toThrow()
    }
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
      azure: 'pr-${SYSTEM_PULLREQUEST_PULLREQUESTNUMBER:-$SYSTEM_PULLREQUEST_PULLREQUESTID}',
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

  it('isolates Azure secrets in independently checked release and preview stages', () => {
    const azure = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'azure' }).content)
    expect(azure.variables).toBeUndefined()
    expect(azure.stages.map((stage: { variables: unknown }) => stage.variables)).toEqual([[{ group: 'capgo-release' }], [{ group: 'capgo-preview' }]])
    expect(azure.stages.every((stage: { dependsOn: unknown[] }) => stage.dependsOn.length === 0)).toBe(true)
    expect(azure.stages.flatMap((stage: { jobs: { job: string }[] }) => stage.jobs.map(job => job.job))).toEqual(['production', 'preview'])
    expect(azure.stages[0].jobs[0].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '$(CAPGO_TOKEN)' })
    expect(azure.stages[1].jobs[0].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '$(CAPGO_PREVIEW_TOKEN)' })
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
      'npx @capgo/cli@latest build request com.example.app --platform android --use-stored-credentials --android-track internal --android-release-status draft',
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

  it('keeps tester and preview builds away from store review whatever the stored settings say', () => {
    const jobs = buildCiJobs({ ...base, product: 'builder', strategy: 'main_preprod', provider: 'github' })
    expect(jobs.filter(job => job.env?.CAPGO_STORE_SUBMIT_REVIEW === 'false').map(job => job.id)).toEqual(['ios-preprod', 'android-preprod'])
    expect(jobs.find(job => job.id === 'android-preprod')?.command).toContain('--android-track internal --android-release-status draft')
    expect(jobs.find(job => job.id === 'android-release')?.env).toBeUndefined()
    const previews = buildCiJobs({ ...base, product: 'builder', strategy: 'pull_request', provider: 'github' })
    expect(previews.filter(job => job.env).map(job => job.id)).toEqual(['ios-release', 'android-release', 'ios-preview', 'android-preview'])

    const github = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'main_preprod', provider: 'github' }).content)
    expect(github.jobs['ios-preprod'].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '${{ secrets.CAPGO_TOKEN }}', CAPGO_STORE_SUBMIT_REVIEW: 'false' })
    expect(github.jobs['ios-release'].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '${{ secrets.CAPGO_TOKEN }}' })
    const azure = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'azure', platforms: ['ios'] }).content)
    expect(azure.stages[1].jobs[0].steps.at(-1).env).toEqual({ CAPGO_TOKEN: '$(CAPGO_PREVIEW_TOKEN)', CAPGO_STORE_SUBMIT_REVIEW: 'false' })
    const gitlab = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'gitlab', platforms: ['ios'] }).content)
    expect(gitlab['capgo-ios-preview'].script.at(-1)).toBe('CAPGO_STORE_SUBMIT_REVIEW=false CAPGO_TOKEN="$CAPGO_PREVIEW_TOKEN" npx @capgo/cli@latest build request com.example.app --platform ios --use-stored-credentials')
  })

  it('builds installable Android previews and TestFlight iOS previews for pull requests', () => {
    const jobs = buildCiJobs({ ...base, product: 'builder', strategy: 'pull_request', provider: 'circleci' })
    expect(jobs.find(job => job.id === 'android-preview')?.command).toBe('npx @capgo/cli@latest build request com.example.app --platform android --use-stored-credentials --build-mode debug --no-playstore-upload --output-upload')
    expect(jobs.find(job => job.id === 'ios-preview')?.command).toBe('npx @capgo/cli@latest build request com.example.app --platform ios --use-stored-credentials')
    // Native previews use a separate key restricted to approved, trusted code.
    expect(jobs.filter(job => job.trigger.kind === 'pull_request').map(job => job.secret)).toEqual(['CAPGO_PREVIEW_TOKEN', 'CAPGO_PREVIEW_TOKEN'])
    expect(jobs.filter(job => job.trigger.kind === 'push').map(job => job.secret)).toEqual(['CAPGO_TOKEN', 'CAPGO_TOKEN'])
    expect(ciKeysFor('builder', 'pull_request')).toEqual([
      { secret: 'CAPGO_TOKEN', role: 'app_admin', purpose: 'release' },
      { secret: 'CAPGO_PREVIEW_TOKEN', role: 'app_admin', purpose: 'preview' },
    ])
    const gitlab = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'gitlab', platforms: ['android'] }).content)
    expect(gitlab['capgo-android-preview'].script.at(-1)).toBe('CAPGO_STORE_SUBMIT_REVIEW=false CAPGO_TOKEN="$CAPGO_PREVIEW_TOKEN" npx @capgo/cli@latest build request com.example.app --platform android --use-stored-credentials --build-mode debug --no-playstore-upload --output-upload')
    const circleci = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'circleci' }).content)
    expect(circleci.workflows.capgo.jobs).toContainEqual({ 'android-preview': { context: BUILDER_PREVIEW_SCOPE, requires: ['approve-builder-preview'], filters: { branches: { ignore: ['main'] } } } })
  })

  it('requires protected or approved credential access for native pull request builds', () => {
    const options = { ...base, product: 'builder', strategy: 'pull_request' } as const
    const github = parse(buildCiPipeline({ ...options, provider: 'github' }).content)
    expect(github.jobs['ios-preview'].environment).toBe(BUILDER_PREVIEW_SCOPE)
    expect(githubSecretCommand('CAPGO_PREVIEW_TOKEN', 'preview', 'builder')).toBe('gh secret set CAPGO_PREVIEW_TOKEN --env capgo-builder-preview')
    expect(githubSecretCommand('CAPGO_PREVIEW_TOKEN', 'preview', 'ota')).toBe('gh secret set CAPGO_PREVIEW_TOKEN')
    const gitlab = parse(buildCiPipeline({ ...options, provider: 'gitlab' }).content)
    for (const platform of ['ios', 'android']) {
      const preview = gitlab[`capgo-${platform}-preview`]
      expect(preview.environment.name).toBe(BUILDER_PREVIEW_SCOPE)
      expect(preview.rules[0]).toEqual({
        if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_PROTECTED == "true" && $CI_MERGE_REQUEST_TARGET_BRANCH_PROTECTED == "true" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID',
        when: 'manual',
      })
      expect(gitlab[`capgo-${platform}-release`].environment.name).toBe('capgo-release')
    }
    const azure = parse(buildCiPipeline({ ...options, provider: 'azure' }).content)
    expect(azure.stages[1].variables).toEqual([{ group: BUILDER_PREVIEW_SCOPE }])
    const bitbucket = parse(buildCiPipeline({ ...options, provider: 'bitbucket' }).content)
    const previewStages = bitbucket.pipelines['pull-requests']['**']
    expect(previewStages[0].step.environment).toBeUndefined()
    expect(previewStages[0].step.script.join(' ')).not.toContain('CAPGO_')
    expect(previewStages[1].stage.trigger).toBe('manual')
    expect(previewStages[1].stage.environment).toBe(BUILDER_PREVIEW_SCOPE)
    expect(previewStages[1].stage.steps).toHaveLength(2)
    const circleci = parse(buildCiPipeline({ ...options, provider: 'circleci' }).content)
    expect(circleci.workflows.capgo.jobs).toContainEqual({ 'approve-builder-preview': { type: 'approval', filters: { branches: { ignore: ['main'] } } } })
  })

  it('restores the encryption key before every live update upload of an encrypted app', () => {
    const restore = 'echo "$CAPGO_PRIVATE_KEY_BASE64" | base64 -d > .capgo_key_v2'
    expect(CI_RESTORE_KEY_COMMAND).toBe(restore)
    const github = buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'github', encrypted: true })
    expect(github.extraSecrets).toEqual([CI_ENCRYPTION_SECRET])
    const workflow = parse(github.content)
    for (const job of ['production', 'preview']) {
      const steps = workflow.jobs[job].steps
      const index = steps.findIndex((step: { run?: string }) => step.run === restore)
      expect(steps[index].env).toEqual({ CAPGO_PRIVATE_KEY_BASE64: '${{ secrets.CAPGO_PRIVATE_KEY_BASE64 }}' })
      expect(steps.at(-1).run).toContain('bundle upload')
      expect(index).toBeLessThan(steps.length - 1)
      const guard = steps.findIndex((step: { id?: string }) => step.id === 'release_head')
      if (guard >= 0)
        expect(guard).toBeGreaterThan(index)
    }
    // Deleting a channel uploads nothing, so it never needs the key.
    expect(workflow.jobs['preview-cleanup'].steps.some((step: { run?: string }) => step.run === restore)).toBe(false)
    const azure = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'azure', encrypted: true }).content)
    expect(azure.stages[0].jobs[0].steps.find((step: { script?: string }) => step.script === restore).env).toEqual({ CAPGO_PRIVATE_KEY_BASE64: '$(CAPGO_PRIVATE_KEY_BASE64)' })
    for (const provider of ['gitlab', 'bitbucket', 'circleci', 'other'] as const)
      expect(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider, encrypted: true }).content, provider).toContain(restore)
    expect(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'github' }).extraSecrets).toEqual([])
    expect(buildCiPipeline({ ...base, product: 'builder', strategy: 'main', provider: 'github', encrypted: true }).content).not.toContain('.capgo_key_v2')
    expect(encryptionSecretCommand('github')).toBe(`base64 < .capgo_key_v2 | tr -d '\\n' | gh secret set CAPGO_PRIVATE_KEY_BASE64 --env capgo-release`)
  })

  it('keeps numeric-looking branch names as strings in every provider', () => {
    const options = { ...base, product: 'ota' as const, strategy: 'main_preprod' as const, productionBranch: '1.0', preprodBranch: 'null' }
    expect(parse(buildCiPipeline({ ...options, provider: 'github' }).content).on.push.branches).toEqual(['1.0', 'null'])
    expect(parse(buildCiPipeline({ ...options, provider: 'azure' }).content).trigger.branches.include).toEqual(['1.0', 'null'])
    expect(Object.keys(parse(buildCiPipeline({ ...options, provider: 'bitbucket' }).content).pipelines.branches)).toEqual(['1.0', 'null'])
    const circleci = parse(buildCiPipeline({ ...options, provider: 'circleci' }).content)
    expect(circleci.workflows.capgo.jobs[0].production.filters.branches.only).toBe('1.0')
    expect(parse(buildCiPipeline({ ...options, provider: 'gitlab' }).content)['capgo-production'].rules).toEqual([{ if: '$CI_COMMIT_BRANCH == "1.0"' }])
  })

  it('runs pull request previews and their cleanup one at a time per pull request', () => {
    const github = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'github' }).content)
    const concurrency = { group: 'capgo-preview-${{ github.event.pull_request.number }}', 'cancel-in-progress': true }
    expect(github.jobs.preview.concurrency).toEqual(concurrency)
    expect(github.jobs['preview-cleanup'].concurrency).toEqual(concurrency)
    expect(github.jobs.production.concurrency).toEqual({
      group: 'capgo-release-com.example.app-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': false,
      queue: 'max',
    })
    const gitlab = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'gitlab' }).content)
    expect(gitlab['capgo-preview'].resource_group).toBe('capgo-pr-$CI_MERGE_REQUEST_IID')
    expect(gitlab['capgo-preview-cleanup'].resource_group).toBe('capgo-pr-$CI_MERGE_REQUEST_IID')
    // Builder previews have no cleanup to race with.
    expect(parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'github' }).content).jobs['ios-preview'].concurrency).toBeUndefined()
  })

  it('guards every GitHub live-update release without changing preview coordination', () => {
    for (const strategy of CI_STRATEGIES) {
      const pipeline = buildCiPipeline({ ...base, product: 'ota', strategy, provider: 'github' })
      const github = parse(pipeline.content)
      for (const job of pipeline.jobs) {
        const rendered = github.jobs[job.id]
        const guard = rendered.steps.findIndex((step: { id?: string }) => step.id === 'release_head')
        if (job.trigger.kind === 'push') {
          expect(rendered.concurrency['cancel-in-progress']).toBe(false)
          expect(rendered.concurrency.queue).toBe('max')
          expect(guard).toBe(rendered.steps.length - 2)
          expect(rendered.steps.at(-1).if).toBe("steps.release_head.outputs.current == 'true'")
        }
        else {
          expect(guard).toBe(-1)
        }
      }
    }
  })

  it('allows the current Git commit to upload and skips superseded commits', () => {
    const github = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'github' }).content)
    const guard = github.jobs.production.steps.find((step: { id?: string }) => step.id === 'release_head')
    expect(guard.shell).toBe('bash')
    const directory = mkdtempSync(join(tmpdir(), 'capgo-release-order-'))
    const gitEnv = { ...env, GIT_AUTHOR_NAME: 'CI Test', GIT_AUTHOR_EMAIL: 'ci-test@example.com', GIT_COMMITTER_NAME: 'CI Test', GIT_COMMITTER_EMAIL: 'ci-test@example.com' }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', input: '', env: gitEnv }).trim()
    try {
      git('init', '--bare', '--quiet')
      git('remote', 'add', 'origin', directory)
      const tree = git('mktree')
      const older = git('commit-tree', tree, '-m', 'older')
      const newer = git('commit-tree', tree, '-p', older, '-m', 'newer')
      git('update-ref', 'refs/heads/main', newer)
      for (const [sha, expected] of [[older, 'false'], [newer, 'true']]) {
        const output = join(directory, `${sha}.output`)
        execFileSync('bash', ['-e', '-o', 'pipefail', '-c', guard.run], {
          cwd: directory,
          env: { ...env, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GITHUB_OUTPUT: output },
        })
        expect(readFileSync(output, 'utf8').trim()).toBe(`current=${expected}`)
      }
      const failedOutput = join(directory, 'missing.output')
      expect(() => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', guard.run], {
        cwd: directory,
        env: { ...env, GITHUB_REF: 'refs/heads/missing', GITHUB_SHA: newer, GITHUB_OUTPUT: failedOutput },
      })).toThrow()
      expect(existsSync(failedOutput)).toBe(false)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
      azure: (yaml: any) => yaml.stages[0].jobs[0].steps.at(-1).script,
      bitbucket: (yaml: any) => yaml.pipelines.branches.main[0].step.script.at(-1),
      circleci: (yaml: any) => yaml.jobs.production.steps.at(-1).run.command,
    } as const
    for (const [provider, read] of Object.entries(commands)) {
      const pipeline = buildCiPipeline({ ...base, productionChannels: [channel], product: 'ota', strategy: 'main', provider: provider as keyof typeof commands })
      expect(read(parse(pipeline.content)), provider).toBe(expected)
    }
    expect(buildCiPipeline({ ...base, productionChannels: [channel], product: 'ota', strategy: 'main', provider: 'other' }).content).toContain(expected)
    expect(parse(buildCiPipeline({ ...base, productionChannels: [channel], product: 'ota', strategy: 'main', provider: 'github' }).content).jobs.production.name).toBe(`Upload live update to ${channel}`)
  })

  it('uploads to every default channel when each platform has its own', () => {
    const pipeline = buildCiPipeline({ ...base, productionChannels: ['production-ios', 'production-android', 'production-ios'], product: 'ota', strategy: 'main', provider: 'github' })
    const job = parse(pipeline.content).jobs.production
    expect(job.steps.at(-1).run).toBe('npx @capgo/cli@latest bundle upload com.example.app --channel production-android,production-ios --auto-bump patch --fail-on-incompatible')
    expect(job.name).toBe('Upload live update to production-android, production-ios')
    expect(normalizeCiChannels([])).toEqual(['production'])
    expect(normalizeCiChannels(null)).toEqual(['production'])
    expect(normalizeCiChannels(['b', '', 'a', 'b'])).toEqual(['a', 'b'])
    // A name with spaces stays one quoted --channel value.
    expect(buildCiPipeline({ ...base, productionChannels: ['Live iOS', 'Live Android'], product: 'ota', strategy: 'main', provider: 'other' }).content)
      .toContain(`--channel 'Live Android,Live iOS' --auto-bump`)
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

  it('remembers a valid custom tester channel and drops unsupported stored names', () => {
    saveCiGuideSelection('user-1', appId, { product: 'ota', strategy: 'main_preprod', provider: 'github', platforms: ['ios'], productionBranch: 'main', preprodBranch: 'preprod', preprodChannel: 'ci-testers' })
    expect(loadCiGuideSelection('user-1', appId).preprodChannel).toBe('ci-testers')
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, JSON.stringify({ preprodChannel: 'production,preprod' }))
    expect(loadCiGuideSelection('user-1', appId).preprodChannel).toBeUndefined()
  })

  it('drops unknown or malformed values', () => {
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, JSON.stringify({ product: 'web', strategy: 'nightly', provider: 'jenkins', platforms: ['ios', 'windows', 'ios'], productionBranch: 'a b' }))
    expect(loadCiGuideSelection('user-1', appId)).toEqual({ platforms: ['ios'], productionBranch: 'main' })
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, '{not json')
    expect(loadCiGuideSelection('user-1', appId)).toEqual({})
  })
})

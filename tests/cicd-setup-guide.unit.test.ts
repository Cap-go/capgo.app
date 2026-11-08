// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { env, execPath } from 'node:process'
import { promisify } from 'node:util'
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
  ENCRYPTED_PREVIEW_SCOPE,
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
const runFile = promisify(execFile)

describe('CI/CD guide pipelines', () => {
  it.each(CI_PROVIDERS)('requires an existing production target for live updates on %s', (provider) => {
    for (const strategy of CI_STRATEGIES) {
      for (const productionChannels of [undefined, [], ['']]) {
        expect(() => buildCiPipeline({ appId, product: 'ota', strategy, provider, productionChannels })).toThrow('An existing production release channel is required')
      }
      // Native builds do not publish to a channel.
      expect(() => buildCiPipeline({ appId, product: 'builder', strategy, provider })).not.toThrow()
    }
  })

  it('keeps an explicitly selected private target without widening release permissions', () => {
    for (const strategy of ['main', 'pull_request'] as const) {
      for (const provider of CI_PROVIDERS) {
        const pipeline = buildCiPipeline({ appId, product: 'ota', strategy, provider, productionChannels: ['private-live'] })
        expect(pipeline.keys.find(key => key.purpose === 'release')).toEqual({ secret: 'CAPGO_TOKEN', role: 'app_uploader', purpose: 'release' })
        expect(pipeline.jobs.find(job => job.id === 'production')?.command).toContain('--channel private-live --auto-bump')
      }
    }
  })

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

  it.each(CI_PRODUCTS.flatMap(product => CI_STRATEGIES.map(strategy => ({ product, strategy }))))('scopes GitHub token access for $product/$strategy', ({ product, strategy }) => {
    const workflow = parse(buildCiPipeline({ ...base, product, strategy, provider: 'github' }).content)
    expect(workflow.env).toBeUndefined()
    for (const job of Object.values<{ env?: unknown, steps: { uses?: string, id?: string, with?: { 'persist-credentials'?: boolean }, env?: Record<string, string> }[] }>(workflow.jobs)) {
      expect(job.env).toBeUndefined()
      for (const checkout of job.steps.filter(step => step.uses === 'actions/checkout@v6'))
        expect(checkout.with?.['persist-credentials']).toBe(false)
      for (const step of job.steps) {
        if (step.id === 'release_head')
          expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
        else
          expect(Object.values(step.env ?? {})).not.toContain('${{ github.token }}')
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
    expect(workflow.jobs.production_build.steps.filter((step: { run?: string }) => step.run).slice(0, 2).map((step: { run: string }) => step.run)).toEqual(['npm ci', 'npm run build'])
    expect(steps.at(-1).run).toBe('npx @capgo/cli@latest bundle upload com.example.app --channel stable --auto-bump patch --fail-on-incompatible')
    expect(steps.some((step: { run?: string }) => step.run?.startsWith('npm ci'))).toBe(false)
    expect(steps.some((step: { run?: string }) => step.run === 'npm run build')).toBe(false)
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
      const githubPipeline = buildCiPipeline({ ...options, provider: 'github' })
      const github = parse(githubPipeline.content)
      for (const { id } of githubPipeline.jobs)
        expect(github.jobs[id].environment, id).toBe(id.includes('preview') ? product === 'builder' ? BUILDER_PREVIEW_SCOPE : undefined : 'capgo-release')
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
    expect(workflow.jobs['preview-cleanup'].steps[0].with).toEqual({ ref: '${{ github.event.pull_request.base.ref }}', 'persist-credentials': false })
    expect(workflow.jobs.preview.steps[0].with).toEqual({ 'persist-credentials': false })
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
    }
    expect(workflow.jobs.production_build.steps.some((step: { run?: string }) => step.run === restore)).toBe(false)
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

  it('keeps GitHub encryption and preview API keys behind the protected preview environment', () => {
    const pipeline = buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'github', encrypted: true })
    const github = parse(pipeline.content)
    expect(github.jobs.preview.environment).toBe(ENCRYPTED_PREVIEW_SCOPE)
    // Cleanup executes repository config too, so it needs the same trusted-code approval.
    expect(github.jobs['preview-cleanup'].environment).toBe(ENCRYPTED_PREVIEW_SCOPE)
    expect(github.jobs['preview-cleanup'].steps.some((step: { run?: string }) => step.run === CI_RESTORE_KEY_COMMAND)).toBe(false)
    expect(github.jobs.production.environment).toBe('capgo-release')
    expect(githubSecretCommand('CAPGO_PREVIEW_TOKEN', 'preview', 'ota', true)).toBe(`gh secret set CAPGO_PREVIEW_TOKEN --env ${ENCRYPTED_PREVIEW_SCOPE}`)
    expect(githubSecretCommand(CI_ENCRYPTION_SECRET, 'preview')).toBe(`gh secret set CAPGO_PRIVATE_KEY_BASE64 --env ${ENCRYPTED_PREVIEW_SCOPE}`)
    expect(encryptionSecretCommand('github', 'preview')).toBe(`base64 < .capgo_key_v2 | tr -d '\\n' | gh secret set CAPGO_PRIVATE_KEY_BASE64 --env ${ENCRYPTED_PREVIEW_SCOPE}`)
  })

  it('requires protected GitLab branches and manual approval for encrypted preview upload and cleanup', () => {
    const gitlab = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'gitlab', encrypted: true }).content)
    for (const id of ['capgo-preview', 'capgo-preview-cleanup']) {
      expect(gitlab[id].rules).toEqual([{
        if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_PROTECTED == "true" && $CI_MERGE_REQUEST_TARGET_BRANCH_PROTECTED == "true" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID',
        when: 'manual',
      }])
      expect(gitlab[id].environment.name).toBe('capgo/pr-$CI_MERGE_REQUEST_IID')
      expect(gitlab[id].resource_group).toBe('capgo-com.example.app')
    }
    expect(gitlab['capgo-preview'].environment.on_stop).toBe('capgo-preview-cleanup')
    expect(gitlab['capgo-preview-cleanup'].environment.action).toBe('stop')
    expect(gitlab['capgo-preview-cleanup'].script).not.toContain(CI_RESTORE_KEY_COMMAND)
  })

  it('requires restricted approval scopes before other providers can use the bundle signing key', () => {
    const options = { ...base, product: 'ota', strategy: 'pull_request', encrypted: true } as const
    const azure = parse(buildCiPipeline({ ...options, provider: 'azure' }).content)
    expect(azure.stages[1].variables).toEqual([{ group: ENCRYPTED_PREVIEW_SCOPE }])
    const bitbucket = parse(buildCiPipeline({ ...options, provider: 'bitbucket' }).content)
    const stages = bitbucket.pipelines['pull-requests']['**']
    expect(stages[0].step.environment).toBeUndefined()
    expect(stages[0].step.script.join(' ')).not.toContain('CAPGO_')
    expect(stages[1].stage).toMatchObject({ name: 'Build approved encrypted previews', trigger: 'manual', environment: ENCRYPTED_PREVIEW_SCOPE })
    expect(stages[1].stage.steps[0].step.script).toContain(CI_RESTORE_KEY_COMMAND)
    const circleci = parse(buildCiPipeline({ ...options, provider: 'circleci' }).content)
    expect(circleci.workflows.capgo.jobs).toContainEqual({ 'approve-encrypted-preview': { type: 'approval', filters: { branches: { ignore: ['main'] } } } })
    expect(circleci.workflows.capgo.jobs).toContainEqual({ preview: { context: ENCRYPTED_PREVIEW_SCOPE, requires: ['approve-encrypted-preview'], filters: { branches: { ignore: ['main'] } } } })
    expect(buildCiPipeline({ ...options, provider: 'other' }).content).toContain('Require trusted-maintainer approval of this exact commit before exposing the bundle signing key.')
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
    expect(github.concurrency).toEqual({
      group: 'capgo-release-com.example.app-${{ github.workflow }}-${{ github.event_name == \'push\' && github.ref || github.run_id }}',
      'cancel-in-progress': false,
      queue: 'max',
    })
    const gitlab = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'pull_request', provider: 'gitlab' }).content)
    expect(gitlab['capgo-preview'].resource_group).toBe('capgo-com.example.app')
    expect(gitlab['capgo-preview-cleanup'].resource_group).toBe('capgo-com.example.app')
    // Builder previews have no cleanup to race with.
    expect(parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'pull_request', provider: 'github' }).content).jobs['ios-preview'].concurrency).toBeUndefined()
  })

  it('uses the same GitLab app lock for production, tester, preview, and cleanup uploads', () => {
    for (const strategy of CI_STRATEGIES) {
      const pipeline = buildCiPipeline({ ...base, product: 'ota', strategy, provider: 'gitlab' })
      const gitlab = parse(pipeline.content)
      for (const job of pipeline.jobs)
        expect(gitlab[`capgo-${job.id}`].resource_group).toBe('capgo-com.example.app')
    }
    const otherApp = parse(buildCiPipeline({ ...base, appId: 'com.example.other', product: 'ota', strategy: 'main', provider: 'gitlab' }).content)
    expect(otherApp['capgo-production'].resource_group).toBe('capgo-com.example.other')
    const builder = parse(buildCiPipeline({ ...base, product: 'builder', strategy: 'main_preprod', provider: 'gitlab' }).content)
    expect(builder['capgo-ios-release'].resource_group).toBeUndefined()
  })

  it('isolates every GitHub live-update branch check between building and uploading', () => {
    for (const strategy of CI_STRATEGIES) {
      const pipeline = buildCiPipeline({ ...base, product: 'ota', strategy, provider: 'github' })
      const github = parse(pipeline.content)
      for (const job of pipeline.jobs) {
        const rendered = github.jobs[job.id]
        if (job.trigger.kind === 'push') {
          const buildId = `${job.id}_build`
          const headId = `${job.id}_head`
          const build = github.jobs[buildId]
          const head = github.jobs[headId]
          expect(github.concurrency['cancel-in-progress']).toBe(false)
          expect(github.concurrency.queue).toBe('max')
          expect(build['runs-on']).toBe('ubuntu-latest')
          expect(build.environment).toBeUndefined()
          expect(build.outputs.artifact_id).toBe('${{ steps.archive.outputs.artifact-id }}')
          const archive = build.steps.at(-1)
          expect(archive.uses).toBe('actions/upload-artifact@v7')
          expect(archive.with.overwrite).toBe(true)
          expect(head.needs).toBe(buildId)
          expect(head['runs-on']).toBe('ubuntu-latest')
          expect(head.steps).toHaveLength(1)
          expect(head.steps[0].id).toBe('release_head')
          expect(head.steps[0].env).toEqual({ GH_TOKEN: '${{ github.token }}' })
          expect(head.steps[0].uses).toBeUndefined()
          expect(head.steps[0].run).not.toMatch(/npm|npx|tar|checkout|artifact/)
          expect(head.outputs.current).toBe('${{ steps.release_head.outputs.current }}')
          expect(head.outputs.check_attempt).toBe('${{ steps.release_head.outputs.check_attempt }}')
          expect(rendered.needs).toEqual([buildId, headId])
          expect(rendered.if).toBe(`needs.${headId}.outputs.current == 'true'`)
          expect(rendered.permissions).toEqual({})
          expect(rendered.steps[0].env).toEqual({ CHECK_ATTEMPT: `\${{ needs.${headId}.outputs.check_attempt }}` })
          expect(rendered.steps[1]).toEqual({
            uses: 'actions/download-artifact@v8',
            with: { 'artifact-ids': `\${{ needs.${buildId}.outputs.artifact_id }}`, path: '${{ runner.temp }}/capgo-release' },
          })
          expect(rendered.steps.some((step: { uses?: string }) => step.uses === 'actions/checkout@v6')).toBe(false)
        }
        else {
          expect(rendered.steps.some((step: { id?: string }) => step.id === 'release_head')).toBe(false)
        }
      }
    }
  })

  it('authenticates the branch check without Git credentials, skips superseded commits, and fails closed on API errors', async () => {
    const github = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'github' }).content)
    const guard = github.jobs.production_head.steps[0]
    expect(guard.shell).toBe('bash')
    const directory = mkdtempSync(join(tmpdir(), 'capgo-release-order-'))
    const newer = 'b'.repeat(40)
    const token = 'cicd-fixture-token'
    const requests: { path: string | undefined, authenticated: boolean }[] = []
    const server = createServer((request, response) => {
      const authenticated = request.headers.authorization === `token ${token}`
      requests.push({ path: request.url, authenticated })
      response.setHeader('Content-Type', 'application/json')
      if (!authenticated) {
        response.writeHead(401).end(JSON.stringify({ message: 'Bad credentials' }))
      }
      else if (request.url === '/repos/example/app/git/ref/heads/release/stable') {
        response.end(JSON.stringify({ object: { sha: newer } }))
      }
      else {
        response.writeHead(404).end(JSON.stringify({ message: 'Not Found' }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected a local API port')
    const guardEnv = {
      ...env,
      PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
      GH_CONFIG_DIR: directory,
      GH_TOKEN: token,
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_REPOSITORY: 'example/app',
      GITHUB_REF: 'refs/heads/release/stable',
      GITHUB_RUN_ATTEMPT: '1',
    }
    try {
      // Keep the shell guard and authenticated HTTP request real without requiring gh locally.
      writeFileSync(join(directory, 'gh'), `#!${execPath}
const [command, endpoint, flag, query] = process.argv.slice(2)
if (command !== 'api' || flag !== '--jq' || query !== '.object.sha') process.exit(2)
void (async () => {
  const response = await fetch(endpoint, { headers: { authorization: 'token ' + (process.env.GH_TOKEN || '') } })
  if (!response.ok) process.exit(1)
  const data = await response.json()
  process.stdout.write(data.object.sha + '\\n')
})().catch(() => process.exit(1))
`, { mode: 0o755 })
      const older = 'a'.repeat(40)
      for (const [sha, expected] of [[older, 'false'], [newer, 'true']]) {
        const output = join(directory, `${sha}.output`)
        await runFile('bash', ['-e', '-o', 'pipefail', '-c', guard.run], {
          cwd: directory,
          env: { ...guardEnv, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
        })
        expect(readFileSync(output, 'utf8').trim()).toBe(`check_attempt=1\ncurrent=${expected}`)
      }
      expect(requests).toEqual(Array.from({ length: 2 }, () => ({ path: '/repos/example/app/git/ref/heads/release/stable', authenticated: true })))
      for (const overrides of [{ GITHUB_REF: 'refs/heads/missing' }, { GH_TOKEN: 'invalid-fixture-token' }, { GH_TOKEN: '' }]) {
        const failedOutput = join(directory, 'failed.output')
        await expect(runFile('bash', ['-e', '-o', 'pipefail', '-c', guard.run], {
          cwd: directory,
          env: { ...guardEnv, ...overrides, GITHUB_SHA: newer, GITHUB_OUTPUT: failedOutput },
        })).rejects.toThrow()
        expect(existsSync(failedOutput)).toBe(false)
      }
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requires a branch check from the current attempt before an upload-only rerun', async () => {
    const workflow = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'github' }).content)
    const check = workflow.jobs.production.steps[0]
    expect(check.shell).toBe('bash')
    const run = (checked: string, current: string) => runFile('bash', ['-e', '-o', 'pipefail', '-c', check.run], {
      env: { ...env, CHECK_ATTEMPT: checked, GITHUB_RUN_ATTEMPT: current },
    })
    await expect(run('1', '1')).resolves.toMatchObject({ stdout: '' })
    await expect(run('1', '2')).rejects.toMatchObject({ stdout: expect.stringContaining('Re-run all jobs') })
    await expect(run('', '2')).rejects.toMatchObject({ stdout: expect.stringContaining('Re-run all jobs') })
    await expect(run('2', '2')).resolves.toMatchObject({ stdout: '' })
  })

  it('preserves generated config dependencies without rerunning install scripts or transferring private keys', async () => {
    const workflow = parse(buildCiPipeline({ ...base, product: 'ota', strategy: 'main', provider: 'github' }).content)
    const archive = workflow.jobs.production_build.steps.find((step: { run?: string }) => step.run?.startsWith('tar ')).run
    const directory = mkdtempSync(join(tmpdir(), 'capgo-release-artifact-'))
    const project = join(directory, 'project')
    const deployment = join(directory, 'deployment')
    const temporary = join(directory, 'temporary')
    try {
      const dependency = join(project, 'node_modules/config-fixture')
      for (const path of ['.git', 'node_modules/config-fixture', 'web/custom', '.config'])
        mkdirSync(join(project, path), { recursive: true })
      mkdirSync(deployment)
      mkdirSync(join(temporary, 'capgo-release'), { recursive: true })
      writeFileSync(join(project, 'web/custom/index.html'), '<p>Built app</p>')
      writeFileSync(join(project, 'web/custom/script.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      writeFileSync(join(project, 'capacitor.config.js'), 'module.exports = require("config-fixture")\n')
      writeFileSync(join(project, '.config/channel.json'), '{"channel":"stable"}')
      writeFileSync(join(project, '.git/config'), 'fixture git configuration')
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'config-fixture', version: '1.0.0', main: 'generated.cjs', scripts: { postinstall: 'node postinstall.cjs' } }))
      writeFileSync(join(dependency, 'postinstall.cjs'), 'require("node:fs").writeFileSync("generated.cjs", \'module.exports = { webDir: "web/custom" }\\n\')\n')
      await runFile(execPath, ['postinstall.cjs'], { cwd: dependency })
      writeFileSync(join(project, '.capgo_key_v2'), 'fixture private key')
      const name = 'cicd-artifact-fixture'
      const version = '1.0.0'
      writeFileSync(join(project, 'package.json'), JSON.stringify({
        name,
        version,
        scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'web/custom/index.html\', \'Changed by install\')"' },
      }))
      writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ name, version, lockfileVersion: 3, packages: { '': { name, version, hasInstallScript: true } } }))
      const commandEnv = { ...env, RUNNER_TEMP: temporary, CHECK_ATTEMPT: '1', GITHUB_RUN_ATTEMPT: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }
      await runFile('bash', ['-e', '-o', 'pipefail', '-c', archive], { cwd: project, env: commandEnv })
      copyFileSync(join(temporary, 'capgo-release.tar.gz'), join(temporary, 'capgo-release/capgo-release.tar.gz'))
      for (const step of workflow.jobs.production.steps.slice(0, -1)) {
        if (step.run)
          await runFile('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: deployment, env: commandEnv })
      }
      for (const path of ['.git', '.capgo_key_v2'])
        expect(existsSync(join(deployment, path)), path).toBe(false)
      expect(readFileSync(join(deployment, 'web/custom/index.html'), 'utf8')).toBe('<p>Built app</p>')
      const config = await runFile(execPath, ['-e', 'process.stdout.write(require("./capacitor.config.js").webDir)'], { cwd: deployment })
      expect(config.stdout).toBe('web/custom')
      expect(readFileSync(join(deployment, '.config/channel.json'), 'utf8')).toBe('{"channel":"stable"}')
      expect(statSync(join(deployment, 'web/custom/script.sh')).mode & 0o777).toBe(0o755)
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
    expect(normalizeCiChannels([])).toEqual([])
    expect(normalizeCiChannels(null)).toEqual([])
    expect(normalizeCiChannels(undefined)).toEqual([])
    expect(normalizeCiChannels(['b', '', 'a', 'b'])).toEqual(['a', 'b'])
    // A name with spaces stays one quoted --channel value.
    expect(buildCiPipeline({ ...base, productionChannels: ['Live iOS', 'Live Android'], product: 'ota', strategy: 'main', provider: 'other' }).content)
      .toContain(`--channel 'Live Android,Live iOS' --auto-bump`)
  })

  it('flags channel names the CLI channel option cannot target', () => {
    expect(isCiChannelSupported('production')).toBe(true)
    expect(isCiChannelSupported('Live app / v2')).toBe(true)
    for (const name of ['', 'a,b', ' production', 'production ', 'prod\nuction', 'prod\tuction', '${{ github.event.head_commit.message }}'])
      expect(isCiChannelSupported(name), JSON.stringify(name)).toBe(false)
  })

  it('rejects GitHub expression syntax before rendering production or tester channel names', () => {
    const channel = '${{ github.event.head_commit.message }}'
    for (const provider of CI_PROVIDERS) {
      for (const strategy of CI_STRATEGIES)
        expect(() => buildCiPipeline({ ...base, productionChannels: [channel], product: 'ota', strategy, provider })).toThrow('Production channels must be supported')
      expect(() => buildCiPipeline({ ...base, product: 'ota', strategy: 'main_preprod', preprodChannel: channel, provider })).toThrow('Tester channel must be supported')
    }
  })

  it.each([
    '$(releaseChannel)',
    'release-$(releaseChannel)',
    '$(Build.SourceBranchName)',
    '$()release-$(releaseChannel)',
    '$[[ inputs.release_channel ]]',
    '$[[]]release-$[[ inputs.release_channel ]]',
    '<< pipeline.git.branch >>',
    '<<>>release-<< pipeline.git.branch >>',
  ])('rejects interpolated release target %s before rendering any pipeline', (channel) => {
    expect(isCiChannelSupported(channel)).toBe(false)
    for (const provider of CI_PROVIDERS) {
      for (const strategy of CI_STRATEGIES)
        expect(() => buildCiPipeline({ ...base, productionChannels: [channel], product: 'ota', strategy, provider })).toThrow('Production channels must be supported')
      expect(() => buildCiPipeline({ ...base, product: 'ota', strategy: 'main_preprod', preprodChannel: channel, provider })).toThrow('Tester channel must be supported')
    }
  })

  it('keeps literal punctuation that is not a CI expression', () => {
    for (const channel of ['release$cash', 'Live (iOS)', 'release$()', 'release$(', 'release$[[', 'release<<', 'release<<>>', 'release$[variables.channel]']) {
      expect(isCiChannelSupported(channel), channel).toBe(true)
      expect(buildCiPipeline({ ...base, productionChannels: [channel], product: 'ota', strategy: 'main', provider: 'azure' }).jobs[0]?.command).toContain(`--channel '${channel}'`)
    }
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

  it('remembers an existing production target and drops malformed stored choices', () => {
    saveCiGuideSelection('user-1', appId, { product: 'ota', strategy: 'main', provider: 'github', platforms: ['ios'], productionBranch: 'main', preprodBranch: 'preprod', productionChannel: 'private-live' })
    expect(loadCiGuideSelection('user-1', appId).productionChannel).toBe('private-live')
    for (const productionChannel of ['', 'private,live', ' private-live', 'private-live\n', null, 42, ['private-live']]) {
      localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, JSON.stringify({ productionChannel }))
      expect(loadCiGuideSelection('user-1', appId).productionChannel).toBeUndefined()
    }
  })

  it('drops stored production and tester names containing provider expressions', () => {
    for (const channel of ['$(releaseChannel)', '${{ github.ref_name }}', '$[[ inputs.channel ]]', '<< pipeline.git.branch >>']) {
      localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, JSON.stringify({ productionChannel: channel, preprodChannel: channel }))
      expect(loadCiGuideSelection('user-1', appId)).toEqual({})
    }
  })

  it('drops unknown or malformed values', () => {
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, JSON.stringify({ product: 'web', strategy: 'nightly', provider: 'jenkins', platforms: ['ios', 'windows', 'ios'], productionBranch: 'a b' }))
    expect(loadCiGuideSelection('user-1', appId)).toEqual({ platforms: ['ios'], productionBranch: 'main' })
    localStorage.setItem(`capgo:cicd-guide:user-1:${appId}`, '{not json')
    expect(loadCiGuideSelection('user-1', appId)).toEqual({})
  })
})

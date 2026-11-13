import type { CiGuideOptions } from '../src/utils/cicdSetupGuide'
import { describe, expect, it } from 'vitest'
import { buildCiAiPrompt } from '../src/utils/cicdAiPrompt'
import {
  buildCiPipeline,
  CI_ENCRYPTION_SECRET,
  CI_PRODUCTS,
  CI_PROVIDERS,
  CI_STRATEGIES,
} from '../src/utils/cicdSetupGuide'

const base = { appId: 'com.example.cicd', productionChannels: ['live-android', 'live-ios'] }
const combinations = CI_PRODUCTS.flatMap(product => CI_STRATEGIES.flatMap(strategy => CI_PROVIDERS.map(provider => ({ product, strategy, provider }))))

describe('CI/CD AI setup prompt', () => {
  it.each(combinations)('keeps the manual workflow and app-scoped keys for $provider/$product/$strategy', (selection) => {
    const options = { ...base, ...selection }
    const pipeline = buildCiPipeline(options)
    const prompt = buildCiAiPrompt(options)
    expect(prompt).toContain(`\`\`\`${pipeline.language}\n${pipeline.content}\`\`\``)
    if (pipeline.file)
      expect(prompt).toContain(`Reference file: ${pipeline.file}`)
    else
      expect(prompt).toContain('no standard workflow path')
    for (const key of pipeline.keys)
      expect(prompt).toContain(`${key.secret}: ${key.role}, scoped only to app "${base.appId}"; ${key.purpose} purpose`)
    expect(prompt).toContain(selection.product === 'ota' ? 'live updates (OTA)' : 'Builder (native builds)')
    expect(prompt).not.toContain('--apikey')
    expect(prompt).not.toContain('__CAPGO_PR_NUMBER__')
  })

  it.each(CI_PROVIDERS)('preserves custom branches and channels for encrypted uploads on %s', (provider) => {
    const options: CiGuideOptions = { ...base, provider, product: 'ota', strategy: 'main_preprod', productionBranch: 'release/stable', preprodBranch: 'release/test', preprodChannel: 'ci testers', encrypted: true }
    const pipeline = buildCiPipeline(options)
    const prompt = buildCiAiPrompt(options)
    expect(prompt).toContain('- Production branch: "release/stable"')
    expect(prompt).toContain('- Preproduction branch: "release/test"')
    expect(prompt).toContain('- Production channels: "live-android", "live-ios"')
    expect(prompt).toContain('- Tester channel: "ci testers"')
    expect(prompt).toContain('- Encryption required: yes')
    expect(prompt).toContain(pipeline.content)
    expect(prompt).toContain(`${CI_ENCRYPTION_SECRET} in capgo-release`)
    expect(prompt).toContain('Do not generate a replacement key, rotate it, disable encryption or upload plaintext')
    expect(prompt).toContain('exclude it from git and artifacts')
  })

  it.each(CI_PROVIDERS)('requires trusted commit approval for signing and encryption previews on %s', (provider) => {
    for (const product of CI_PRODUCTS) {
      const prompt = buildCiAiPrompt({ ...base, provider, product, strategy: 'pull_request', encrypted: product === 'ota' })
      expect(prompt).toContain('A trusted maintainer must review the exact commit')
      expect(prompt).toContain(provider === 'gitlab' && product === 'ota' ? 'capgo/pr-*' : product === 'builder' ? 'capgo-builder-preview' : 'capgo-encrypted-preview')
      expect(prompt).toContain('Do not silently enable unprotected previews or change my selected strategy')
      if (provider === 'github') {
        expect(prompt).toContain('enable Prevent self-review, disable administrator bypass')
        expect(prompt).toContain(`gh secret set CAPGO_PREVIEW_TOKEN --env ${product === 'builder' ? 'capgo-builder-preview' : 'capgo-encrypted-preview'}`)
      }
      if (provider === 'gitlab') {
        expect(prompt).toContain('Masked and Protected')
        expect(prompt).not.toContain('Protect variable off')
        expect(prompt).toContain('both branches must be protected')
      }
    }
  })

  it('uses the limited ordinary OTA preview key separately from protected encryption secrets', () => {
    const github = buildCiAiPrompt({ ...base, product: 'ota', strategy: 'pull_request', provider: 'github' })
    expect(github).toContain('gh secret set CAPGO_TOKEN --env capgo-release')
    expect(github).toContain('gh secret set CAPGO_PREVIEW_TOKEN\n')
    expect(github).not.toContain(CI_ENCRYPTION_SECRET)
    const gitlab = buildCiAiPrompt({ ...base, product: 'ota', strategy: 'pull_request', provider: 'gitlab' })
    expect(gitlab).toContain('Protect variable off and Environment scope capgo/pr-*')
  })

  it('keeps provider-enforced release branch controls outside editable YAML', () => {
    const options: CiGuideOptions = { ...base, product: 'ota', strategy: 'main_preprod', provider: 'github', productionBranch: 'trunk', preprodBranch: 'qa' }
    const prompts = Object.fromEntries(CI_PROVIDERS.map(provider => [provider, buildCiAiPrompt({ ...options, provider })]))
    expect(prompts.github).toContain('allow only trunk, qa')
    expect(prompts.gitlab).toContain('Protect these release branches in Branch rules: trunk, qa')
    expect(prompts.azure).toContain('Approvals and checks allowing only refs/heads/trunk, refs/heads/qa')
    expect(prompts.azure).toContain('fail when protection status is unknown')
    expect(prompts.bitbucket).toContain('Premium deployment permissions to allow only trunk, qa')
    expect(prompts.circleci).toContain('pipeline.git.branch == "trunk" or pipeline.git.branch == "qa"')
    expect(prompts.other).toContain('restricted by the provider to these protected branches: trunk, qa')
  })

  it.each(CI_PROVIDERS)('keeps Builder platforms and stored credential commands on %s', (provider) => {
    const prompt = buildCiAiPrompt({ appId: base.appId, provider, product: 'builder', strategy: 'main', platforms: ['android'] })
    expect(prompt).toContain('- Native platforms: android')
    expect(prompt).toContain(`npx @capgo/cli@latest build credentials push ${base.appId} --platform android`)
    expect(prompt).not.toContain('--platform ios')
    expect(prompt).not.toContain('Production channels:')
    expect(prompt).toContain('CAPGO_STORE_SUBMIT_REVIEW=false')
  })

  it('requires repository discovery, review and actual CI evidence without leaking credentials', () => {
    const prompt = buildCiAiPrompt({ ...base, product: 'ota', strategy: 'main', provider: 'github' })
    for (const requirement of ['Capacitor config', 'lockfile', 'workspace/monorepo', 'webDir', 'Preserve existing CI jobs', 'provider validator/linter', 'PR or a reviewable diff', 'actual CI run succeeds', 'CI run URL', 'secure stdin entry', 'Ask me only for missing provider permissions'])
      expect(prompt).toContain(requirement)
    expect(prompt).toContain('key create generates an encryption key pair, not a CI API token')
    expect(prompt).toContain('Never put API keys, encryption private keys or signing credentials in repository files, commits, PR descriptions, chat, command arguments or logs')
    expect(prompt).toContain('Copying this prompt or saving a workflow does not mean the pipeline is finished')
  })

  it('rejects unresolved release channels and invalid selections like the manual workflow', () => {
    expect(() => buildCiAiPrompt({ appId: base.appId, product: 'ota', provider: 'github', strategy: 'main' })).toThrow('An existing production release channel is required')
    expect(() => buildCiAiPrompt({ ...base, product: 'ota', provider: 'github', strategy: 'main_preprod', productionBranch: 'trunk', preprodBranch: 'trunk' })).toThrow('Production and preproduction branches must be different')
  })
})

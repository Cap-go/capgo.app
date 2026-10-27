import assert from 'node:assert/strict'
import { stripVTControlCharacters } from 'node:util'
import { test } from 'bun:test'
import { BUILDER_STEP_IDS } from '../src/app/builder-checklist.ts'
import { getAppTodoSteps } from '../src/app/todo.ts'
import { formatSetupNotice, getAgentTrial, getSetupNotice, getTrialNotice, reconcileSetupProgress } from '../src/onboarding/setup-notices.ts'
import { shouldEvaluateSetupNotice, shouldRefreshSetupProgress } from '../src/onboarding/setup-notice-policy.ts'
import { formatAgentTodoTrialItem, formatAgentUploadTrialNote, isAgentInvocation } from '../src/shared/agent-notices.ts'

const appId = 'com.example.setup'
const now = Date.parse('2026-01-01T12:00:00Z')
const orgId = '00000000-0000-4000-8000-000000000001'
const billing = { status: 'available', orgId, trialEndsAt: new Date(now + 36 * 3600000).toISOString(), isPaying: false, hasCredits: false }
const otaIds = getAppTodoSteps({ onboarding: { setup: { todo_list_version: 3 } } }).steps.map(step => step.id)
function fixture(paths = ['ota', 'builder']) {
  const setup = { todo_list_version: 4, paths, selected_path: paths[0], steps: {} }
  if (paths.includes('ota')) {
    setup.ota_todo_list_version = '1'
    setup.steps.ota = Object.fromEntries(otaIds.map(id => [id, { status: id === 'login_cli_mcp' ? 'done' : 'pending' }]))
  }
  if (paths.includes('builder')) {
    setup.builder_todo_list_version = '1'
    setup.steps.builder = Object.fromEntries(Object.entries(BUILDER_STEP_IDS).map(([platform, ids]) => [platform, Object.fromEntries(ids.map(id => [id, { status: 'pending' }]))]))
  }
  return { onboarding: { setup }, billing: { ...billing }, checkErrors: [] }
}
function finish(progress, product, platform = 'ios') {
  const steps = product === 'ota' ? progress.onboarding.setup.steps.ota : progress.onboarding.setup.steps.builder[platform]
  for (const step of Object.values(steps)) step.status = 'done'
  return progress
}
const message = progress => formatSetupNotice(getSetupNotice(appId, progress, 'https://console.example.com'), now)
const agentMessage = (progress, at = now) => formatSetupNotice(getSetupNotice(appId, progress, 'https://console.example.com'), at, true)

test('agent notice selection reuses environment detection without treating CI alone as an agent', () => {
  for (const env of [{ CODEX_THREAD_ID: 'fixture-thread' }, { CLAUDECODE: '1' }, { CURSOR_AGENT: '1' }])
    assert.equal(isAgentInvocation(env), true)
  assert.equal(isAgentInvocation({}), false)
  assert.equal(isAgentInvocation({ CI: 'true', GITHUB_ACTIONS: 'true' }), false)
})

// Agent trial dates use the local calendar day; pin it so the copy can be asserted verbatim.
process.env.TZ = 'UTC'
const trialEndsAt = '2026-01-15T12:00:00Z'
const trialLink = 'https://console.example.com/settings/organization/plans?trial_card=1'
const trialLine = `- Add a payment method before Jan 15, 2026 to keep live updates running after the free trial (14 days left; devices stop receiving updates without a plan; no charge before then): ${trialLink}`
const builderTrialLine = `- Add a payment method before Jan 15, 2026 to keep cloud builds running after the free trial (14 days left; new builds are blocked without a plan; no charge before then): ${trialLink}`
const otaSetupLines = ['- Live updates: not finished yet. Next: Create a channel for this app to receive live updates.', '  Check progress: npx @capgo/cli@latest app todo --list ota']
const nextSteps = (...lines) => ['Capgo — next steps', '', ...lines].join('\n')
const onTrial = (progress) => {
  progress.billing.trialEndsAt = trialEndsAt
  return progress
}

test('agents get the unfinished step and the active trial as plain next steps, whatever the checklist state', () => {
  assert.equal(agentMessage(onTrial(fixture(['ota']))), nextSteps(...otaSetupLines, trialLine))
  assert.equal(agentMessage(onTrial(finish(fixture(['ota']), 'ota'))), nextSteps('- Live updates: set up.', trialLine))
  assert.equal(agentMessage(onTrial(finish(fixture(), 'builder', 'android'))), nextSteps('- Android cloud builds: set up.', builderTrialLine))
  assert.equal(agentMessage(onTrial(finish(finish(fixture(), 'ota'), 'builder', 'android'))), nextSteps('- Live updates and Android cloud builds: set up.', trialLine))
})

test('agent Builder steps keep the platform label and point at the platform wizard', () => {
  for (const [platform, line, action] of [
    ['ios', '- iOS builds: not finished yet. Choose where your iOS build will be installed.', 'build init --platform ios'],
    ['android', '- Android builds: not finished yet. Add a signing keystore to continue setting up cloud builds.', 'build init --platform android'],
  ]) {
    const progress = onTrial(fixture(['builder']))
    progress.onboarding.setup.selected_builder_platform = platform
    progress.onboarding.setup.steps.builder[platform].start_setup.status = 'done'
    assert.equal(agentMessage(progress), nextSteps(line, `  Check progress: npx @capgo/cli@latest ${action}`, builderTrialLine))
  }
})

test('agent notices address nobody and pitch no secondary product', () => {
  for (const progress of [fixture(), finish(fixture(), 'ota'), finish(fixture(), 'builder', 'ios')]) {
    const text = agentMessage(onTrial(progress))
    assert.doesNotMatch(text, /AI ASSISTANT|final response|recommend|prominent|can also|Builder|explore|oid=/i)
    assert.equal(text, stripVTControlCharacters(text))
  }
})

test('the agent trial line uses the singular for the last day', () => {
  assert.match(agentMessage(onTrial(fixture(['ota'])), Date.parse(trialEndsAt) - 20 * 3_600_000), /Jan 15, 2026 .*\(1 day left;/)
})

test('agent todo and upload trial copy keep the tested wording and the short trial-card link', () => {
  const trial = { endsAt: Date.parse(trialEndsAt), plansUrl: `https://console.example.com/settings/organization/plans?oid=${orgId}` }
  assert.equal(formatAgentTodoTrialItem(trial), `[ ] Pending: Add a payment method before Jan 15, 2026 so live updates keep reaching devices after the free trial (no charge before then): ${trialLink}`)
  assert.equal(formatAgentTodoTrialItem(trial, true), `[ ] Pending: Add a payment method before Jan 15, 2026 so cloud builds keep working after the free trial (no charge before then): ${trialLink}`)
  assert.equal(formatAgentUploadTrialNote(14, 'https://console.example.com/settings/organization/plans', now), `Add a payment method before Jan 15, 2026 to keep delivering updates like this one: the free trial ends then, and devices stop receiving live updates until a plan is active. No charge before Jan 15, 2026: ${trialLink}`)
})

test('agents get no trial line without an active trial, and no notice when nothing is left to say', () => {
  for (const value of [undefined, { status: 'unavailable' }, { ...billing, isPaying: true }, { ...billing, hasCredits: true }]) {
    const progress = fixture(['ota'])
    progress.billing = value
    assert.equal(agentMessage(progress), nextSteps(...otaSetupLines))
    assert.equal(agentMessage(finish(progress, 'ota')), undefined)
  }
  for (const patch of [{ trialEndsAt: null }, { trialEndsAt: '2025-12-01T00:00:00Z' }, { trialEndsAt: '2025-12-01T00:00:05Z', orgCreatedAt: '2025-12-01T00:00:00Z', hasPaid: false }]) {
    const progress = fixture(['ota'])
    Object.assign(progress.billing, patch)
    assert.doesNotMatch(agentMessage(progress) ?? '', /payment method|trial/)
    assert.equal(agentMessage(finish(progress, 'ota')), undefined, 'a finished setup without a trial leaves no next step')
  }
  const directOffer = fixture(['ota'])
  Object.assign(directOffer.billing, { trialEndsAt: '2025-12-01T00:00:05Z', orgCreatedAt: '2025-12-01T00:00:00Z', hasPaid: false })
  assert.equal(getSetupNotice(appId, directOffer, 'https://console.example.com').kind, 'plan')
  assert.equal(agentMessage(directOffer), undefined)
  assert.equal(formatSetupNotice(undefined, now, true), undefined)
})

test('agents get the trial line on its own when no setup notice applies; humans get nothing', () => {
  const progress = onTrial(fixture(['ota']))
  progress.onboarding.setup.todo_list_version = 3
  assert.equal(getSetupNotice(appId, progress, 'https://console.example.com'), undefined)
  const notice = getTrialNotice(appId, progress, 'https://console.example.com', now)
  assert.equal(formatSetupNotice(notice, now, true), nextSteps(trialLine))
  assert.equal(formatSetupNotice(notice, now), undefined)
  assert.equal(getTrialNotice(appId, progress, 'https://console.example.com', Date.parse(trialEndsAt)), undefined)
  progress.billing.isPaying = true
  assert.equal(getTrialNotice(appId, progress, 'https://console.example.com', now), undefined)
})

test('the active trial for agent output comes only from the progress billing snapshot', () => {
  const progress = onTrial(fixture(['ota']))
  assert.deepEqual(getAgentTrial(progress, 'https://console.example.com', now), { endsAt: Date.parse(trialEndsAt), plansUrl: `https://console.example.com/settings/organization/plans?oid=${orgId}` })
  assert.equal(getAgentTrial(progress, 'https://console.example.com', Date.parse(trialEndsAt)), undefined)
  assert.equal(getAgentTrial({ ...progress, billing: undefined }, 'https://console.example.com', now), undefined)
})

test('human setup copy is unchanged when the setup notice carries billing', () => {
  const progress = onTrial(fixture(['ota']))
  assert.equal(getSetupNotice(appId, progress, 'https://console.example.com').billing.orgId, orgId)
  assert.equal(message(progress), message({ ...progress, billing: undefined }))
})

test('only app-specific human-readable commands start the optional progress request', () => {
  for (const command of ['bundle list', 'bundle upload', 'channel list', 'doctor', 'build request'])
    assert.equal(shouldEvaluateSetupNotice(command, {}), true)
  for (const command of ['app list', 'organization list', 'app todo', 'build init', 'mcp', 'init'])
    assert.equal(shouldEvaluateSetupNotice(command, {}), false)
  for (const options of [{ json: true }, { outputText: true }, { quiet: true }, { silent: true }, { format: 'json' }])
    assert.equal(shouldEvaluateSetupNotice('bundle list', options), false)
})
test('only commands that can change setup need a post-success refresh', () => {
  for (const command of ['bundle upload', 'channel add', 'app add', 'build request'])
    assert.equal(shouldRefreshSetupProgress(command), true)
  for (const command of ['bundle list', 'bundle zip', 'channel list', 'doctor', 'app todo'])
    assert.equal(shouldRefreshSetupProgress(command), false)
})

test('an unfinished OTA-only list focuses on its next task without Builder or billing copy', () => {
  const text = message(fixture(['ota']))
  assert.match(text, /Finish setting up live updates/i)
  assert.match(text, /Create a channel/)
  assert.match(text, /app todo --list ota/)
  assert.doesNotMatch(text, /Builder|plan|trial|subscrib/i)
})
test('an unfinished Builder-only list offers the right platform and no OTA or billing copy', () => {
  const progress = fixture(['builder'])
  progress.onboarding.setup.selected_builder_platform = 'android'
  progress.onboarding.setup.steps.builder.android.start_setup.status = 'done'
  const text = message(progress)
  assert.match(text, /Finish setting up Android builds/i)
  assert.match(text, /Add a signing keystore/)
  assert.match(text, /build init --platform android/)
  assert.doesNotMatch(text, /OTA|plan|trial|subscrib/i)
})
test('dual assignment focuses on the started OTA list with a brief Builder mention', () => {
  const text = message(fixture())
  assert.match(text.split('\n')[0], /Finish setting up live updates/)
  assert.match(text, /You can also explore.*Builder/)
  assert.doesNotMatch(text, /trial|subscrib/i)
})
test('one started Builder list wins over an unstarted OTA list', () => {
  const progress = fixture()
  progress.onboarding.setup.steps.ota.login_cli_mcp.status = 'pending'
  progress.onboarding.setup.steps.builder.android.start_setup.status = 'done'
  const text = message(progress)
  assert.match(text.split('\n')[0], /Finish setting up .*builds/)
  assert.match(text, /--platform android/)
  assert.match(text, /You can also explore live updates/)
})
test('both started lists use the selected path without equal product pitches', () => {
  const progress = fixture()
  progress.onboarding.setup.selected_path = 'builder'
  progress.onboarding.setup.steps.builder.ios.start_setup.status = 'done'
  const text = message(progress)
  assert.match(text.split('\n')[0], /Finish setting up .*builds/)
  assert.match(text, /You can also continue setting up live updates/)
})
test('the unreachable dual-unstarted state does not invent a two-product pitch', () => {
  const progress = fixture()
  progress.onboarding.setup.steps.ota.login_cli_mcp.status = 'pending'
  assert.equal(message(progress), undefined)
})
for (const platform of ['ios', 'android']) {
  test(`one finished Builder platform (${platform}) prioritizes plans over unfinished OTA and the other platform`, () => {
    const text = message(finish(fixture(), 'builder', platform))
    assert.match(text.split('\n')[0], /cloud builds are set up/)
    assert.match(text, /1 day, 12 hours/)
    assert.match(text, /Choose a Capgo plan/)
    assert.ok(text.indexOf('Choose a Capgo plan') < text.indexOf('You can also'))
    assert.match(text, new RegExp(`You can also.*${platform === 'ios' ? 'Android' : 'iOS'}.*live update`))
    assert.match(text, new RegExp(`plans\\?oid=${orgId}`))
    assert.doesNotMatch(text, /Finish setting up live updates/)
  })
}
test('Builder-only completion suggests the other platform briefly without mentioning an absent OTA list', () => {
  const text = message(finish(fixture(['builder']), 'builder'))
  assert.match(text, /Choose a Capgo plan/)
  assert.match(text, /You can also.*Android/)
  assert.doesNotMatch(text, /OTA/)
})
test('OTA completion prioritizes trial and plans with brief unfinished Builder guidance', () => {
  const text = message(finish(fixture(), 'ota'))
  assert.match(text.split('\n')[0], /Live updates are set up/)
  assert.match(text, /Choose a Capgo plan/)
  assert.match(text, /You can also.*Builder/)
  assert.ok(text.indexOf('Choose a Capgo plan') < text.indexOf('You can also'))
})
test('all completed lists have no unfinished setup prompt', () => {
  const progress = finish(finish(finish(fixture(), 'ota'), 'builder', 'ios'), 'builder', 'android')
  const text = message(progress)
  assert.match(text, /Choose a Capgo plan/)
  assert.doesNotMatch(text, /You can also|Finish setting up|Explore/i)
})
test('warning and skipped cloud-build steps are not successful Builder completion', () => {
  for (const status of ['warning', 'skipped', 'pending']) {
    const progress = finish(fixture(['builder']), 'builder')
    progress.onboarding.setup.steps.builder.ios.successful_cloud_build.status = status
    assert.match(message(progress), /Finish setting up .*builds/)
    assert.doesNotMatch(message(progress), /Choose a Capgo plan/)
  }
})
test('skipped optional signing steps still allow a successfully finished platform', () => {
  const progress = finish(fixture(['builder']), 'builder')
  progress.onboarding.setup.steps.builder.ios.prepare_certificate.status = 'skipped'
  assert.match(message(progress), /Choose a Capgo plan/)
})
test('paid, credit-funded, unavailable, malformed and absent billing do not trigger purchase copy', () => {
  for (const value of [undefined, { status: 'unavailable' }, { ...billing, isPaying: true }, { ...billing, hasCredits: true }, { ...billing, isPaying: null }, { ...billing, orgId: '' }, { ...billing, trialEndsAt: 'invalid' }]) {
    const progress = finish(fixture(), 'ota')
    progress.billing = value
    assert.equal(message(progress), undefined)
  }
})
test('expired and absent trials still offer a plan after setup completes', () => {
  for (const trialEndsAt of [null, '2025-12-01T00:00:00Z']) {
    const progress = finish(fixture(['ota']), 'ota')
    progress.billing.trialEndsAt = trialEndsAt
    const text = message(progress)
    assert.match(text, /Choose a Capgo plan/)
    assert.doesNotMatch(text, /ends in|negative|NaN/)
  }
})
test('expiry is calculated when displayed, including a trial ending during the command', () => {
  const notice = getSetupNotice(appId, finish(fixture(['ota']), 'ota'), 'https://console.example.com')
  assert.match(formatSetupNotice(notice, now + 35 * 3600000), /1 hour/)
  assert.match(formatSetupNotice(notice, now + 37 * 3600000), /trial has ended/)
})
test('legacy, unsupported and explicitly skipped onboarding stays quiet', () => {
  for (const patch of [{ todo_list_version: 3 }, { todo_list_version: 5 }, { outcome: 'skipped' }, { ota_todo_list_version: '2' }]) {
    const progress = fixture(['ota'])
    Object.assign(progress.onboarding.setup, patch)
    assert.equal(message(progress), undefined)
  }
})
test('failed OTA checks do not certify OTA completion, while a finished Builder platform remains independent', () => {
  const progress = finish(fixture(), 'ota')
  progress.checkErrors = ['run_device']
  assert.doesNotMatch(message(progress) ?? '', /Live updates are set up/)
  finish(progress, 'builder')
  assert.match(message(progress), /cloud builds are set up/)
})
test('successful local reports reconcile a stale snapshot without changing unrelated steps, billing or the input', () => {
  const progress = fixture()
  const before = JSON.stringify(progress)
  const reconciled = reconcileSetupProgress(progress, ['add_updater', 'add_code'])
  assert.equal(reconciled.onboarding.setup.steps.ota.add_code.status, 'done')
  assert.equal(reconciled.onboarding.setup.steps.ota.add_updater.status, 'done')
  assert.equal(reconciled.onboarding.setup.steps.ota.run_device.status, 'pending')
  assert.deepEqual(reconciled.billing, billing)
  assert.equal(JSON.stringify(progress), before)
  assert.equal(reconcileSetupProgress(fixture(['builder']), ['add_code']).onboarding.setup.steps.ota, undefined)
})


test('setup copy separates the next step and one primary command from a brief secondary product mention', () => {
  const progress = fixture()
  progress.onboarding.setup.selected_path = 'builder'
  progress.onboarding.setup.steps.builder.ios.start_setup.status = 'done'
  const text = message(progress)
  assert.equal(text.split('\n')[0], 'Finish setting up iOS builds')
  assert.doesNotMatch(text, /App:|com\.example\.setup/)
  assert.match(text, /\n\nChoose where your iOS build will be installed\./)
  assert.match(text, /\n\nnpx @capgo\/cli@latest build init --platform ios/)
  assert.match(text, /\n\nYou can also continue setting up live updates\.$/)
  assert.equal(text.match(/npx @capgo\/cli@latest/g)?.length, 1)
})

test('completed setup copy gives the trial and plan link their own lines without a raw timestamp', () => {
  const text = message(finish(fixture(), 'ota'))
  assert.equal(text.split('\n')[0], 'Live updates are set up')
  assert.doesNotMatch(text, /App:|com\.example\.setup/)
  assert.match(text, /trial ends in 1 day, 12 hours\./)
  assert.match(text, /Choose a Capgo plan to continue after your trial\.\n\nView plans: https:\/\//)
  assert.doesNotMatch(text, /2026-01-03|T00:00:00/)
})


test('self-hosted plans links preserve the web path prefix and discard unrelated query and fragment', () => {
  const notice = getSetupNotice(appId, finish(fixture(['ota']), 'ota'), 'https://console.example.com/console/?unused=yes#old')
  assert.equal(notice.billing.plansUrl, `https://console.example.com/console/settings/organization/plans?oid=${orgId}`)
})

test('an unreliable OTA observation cannot redirect an unfinished setup notice to Builder', () => {
  const progress = fixture()
  progress.checkErrors = ['run_device']
  assert.equal(message(progress), undefined)
  finish(progress, 'builder')
  assert.match(message(progress), /iOS cloud builds are set up/)
})

test('approved profile guidance explains the task and omits the app identifier', () => {
  const progress = fixture()
  progress.onboarding.setup.selected_path = 'builder'
  const steps = progress.onboarding.setup.steps.builder.ios
  for (const key of ['start_setup', 'choose_destination', 'connect_app_store', 'prepare_certificate']) steps[key].status = 'done'
  const text = message(progress)
  assert.equal(text, [
    'Finish setting up iOS builds', '',
    'Add an iOS provisioning profile to continue setting up cloud builds.', '',
    'npx @capgo/cli@latest build init --platform ios', '',
    'You can also continue setting up live updates.',
  ].join('\n'))
})

test('expired and unknown trials have the approved plan wording', () => {
  for (const [trialEndsAt, sentence] of [[null, 'Choose a Capgo plan.'], ['2025-12-01T00:00:00Z', 'Choose a Capgo plan to continue using Capgo.']]) {
    const progress = finish(fixture(['ota']), 'ota')
    progress.billing.trialEndsAt = trialEndsAt
    assert.ok(message(progress).includes(sentence))
  }
})

test('orgs created without a trial (direct offer) never see trial wording', () => {
  const progress = finish(fixture(['ota']), 'ota')
  progress.billing.trialEndsAt = '2025-12-01T00:00:05Z'
  progress.billing.orgCreatedAt = '2025-12-01T00:00:00Z'
  progress.billing.hasPaid = false
  const text = message(progress)
  assert.ok(text.includes('Choose a plan to start using Capgo. 14-day money-back guarantee. Cancel anytime.'), text)
  assert.doesNotMatch(text, /trial/i)
  assert.ok(text.includes('View plans: https://console.example.com/settings/organization/plans?oid='))
})

test('a churned direct-offer org (paid before) or an older server without hasPaid keeps the trial wording', () => {
  for (const hasPaid of [true, undefined]) {
    const progress = finish(fixture(['ota']), 'ota')
    progress.billing.trialEndsAt = '2025-12-01T00:00:05Z'
    progress.billing.orgCreatedAt = '2025-12-01T00:00:00Z'
    if (hasPaid !== undefined)
      progress.billing.hasPaid = hasPaid
    const text = message(progress)
    assert.ok(text.includes('Your trial has ended.'), text)
    assert.ok(!text.includes('money-back'), text)
  }
})

test('a null orgCreatedAt (as returned by the server when unknown) keeps the trial wording', () => {
  const progress = finish(fixture(['ota']), 'ota')
  progress.billing.trialEndsAt = '2025-12-01T00:00:05Z'
  progress.billing.orgCreatedAt = null
  const text = message(progress)
  assert.ok(text.includes('Your trial has ended.'), text)
  assert.ok(!text.includes('money-back'), text)
})

test('a normal 15-day trial with orgCreatedAt keeps the trial wording', () => {
  const progress = finish(fixture(['ota']), 'ota')
  progress.billing.trialEndsAt = '2025-12-16T00:00:00Z'
  progress.billing.orgCreatedAt = '2025-12-01T00:00:00Z'
  const text = message(progress)
  assert.ok(text.includes('Your trial has ended.'), text)
  assert.ok(text.includes('Choose a Capgo plan to continue using Capgo.'), text)
})


test('trial reminders handle the last minute and the exact expiration instant', () => {
  const progress = finish(fixture(['ota']), 'ota')
  const notice = getSetupNotice(appId, progress)
  const expires = Date.parse(progress.billing.trialEndsAt)
  assert.match(formatSetupNotice(notice, expires - 30_000), /Your trial ends in less than a minute\./)
  assert.match(formatSetupNotice(notice, expires), /Your trial has ended\./)
  assert.match(formatSetupNotice(notice, expires), /continue using Capgo\./)
})

test('completed OTA gives a started Builder checklist a continue mention', () => {
  const progress = finish(fixture(), 'ota')
  progress.onboarding.setup.steps.builder.ios.start_setup.status = 'done'
  assert.match(message(progress), /You can also continue setting up cloud builds\./)
})

test('direct-offer orgs that never paid see the plan first, before setup', () => {
  const progress = fixture(['ota'])
  progress.billing.trialEndsAt = '2025-12-01T00:00:05Z'
  progress.billing.orgCreatedAt = '2025-12-01T00:00:00Z'
  progress.billing.hasPaid = false
  const notice = getSetupNotice(appId, progress, 'https://console.example.com')
  assert.equal(notice?.kind, 'plan')
  const text = message(progress)
  assert.equal(text.split('\n')[0], 'Choose a plan to start using Capgo. 14-day money-back guarantee. Cancel anytime.')
  assert.ok(text.includes('View plans: https://console.example.com/settings/organization/plans?oid='), text)
  assert.ok(text.includes('Then finish setting up live updates.'), text)
  assert.doesNotMatch(text, /trial|is set up|are set up|setup is complete/i)
})

test('trial orgs, churned orgs, paying orgs and orgs with credits keep the setup notice first', () => {
  const variants = [
    billing => billing,
    billing => Object.assign(billing, { trialEndsAt: '2025-12-01T00:00:05Z', orgCreatedAt: '2025-12-01T00:00:00Z', hasPaid: true }),
    billing => Object.assign(billing, { trialEndsAt: '2025-12-01T00:00:05Z', orgCreatedAt: '2025-12-01T00:00:00Z', hasPaid: false, isPaying: true }),
    billing => Object.assign(billing, { trialEndsAt: '2025-12-01T00:00:05Z', orgCreatedAt: '2025-12-01T00:00:00Z', hasPaid: false, hasCredits: true }),
  ]
  for (const variant of variants) {
    const progress = fixture(['ota'])
    variant(progress.billing)
    assert.equal(getSetupNotice(appId, progress, 'https://console.example.com')?.kind, 'setup')
  }
})

test('the plan-first notice keeps the unreliable-snapshot guards', () => {
  const direct = (progress) => {
    Object.assign(progress.billing, { trialEndsAt: '2025-12-01T00:00:05Z', orgCreatedAt: '2025-12-01T00:00:00Z', hasPaid: false })
    return progress
  }
  const withErrors = direct(fixture(['ota']))
  withErrors.checkErrors = ['add_channel']
  assert.equal(getSetupNotice(appId, withErrors, 'https://console.example.com'), undefined)
  const dualPending = direct(fixture(['ota', 'builder']))
  dualPending.onboarding.setup.steps.ota.login_cli_mcp.status = 'pending'
  assert.equal(getSetupNotice(appId, dualPending, 'https://console.example.com'), undefined)
})

#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { BUILDER_STEP_IDS } from '../../src/services/builderOnboardingChecklist.ts'
import messages from '../../messages/en.json'
import { getAppTodoSteps, formatAppTodoList } from '../src/app/todo.ts'

const setup = {
  todo_list_version: 4,
  builder_todo_list_version: '1',
  paths: ['builder'],
  selected_path: 'builder',
  selected_builder_platform: 'android',
  outcome: 'completed', // A legacy overall outcome must not invent a successful build.
  steps: {
    builder: {
      ios: {
        start_setup: { status: 'done', at: '2026-01-01T00:00:00Z' },
        choose_destination: { status: 'done', annotation: 'import_ad_hoc', annotation_type: 'note' },
        successful_cloud_build: { status: 'pending' },
      },
      android: {
        start_setup: { status: 'done' },
        prepare_keystore: { status: 'skipped' },
        successful_cloud_build: { status: 'warning', annotation: 'cloud_build_failed', annotation_type: 'warning', at: '2026-01-02T00:00:00Z' },
      },
    },
  },
}
const progress = { onboarding: { setup }, hasChannel: true }
const before = JSON.stringify(progress)
const result = getAppTodoSteps(progress)
assert.equal(result.path, 'builder', 'a sole authoritative Builder assignment selects the Builder checklist')
assert.equal(result.selectedPlatform, 'android')
assert.equal(result.steps.length, 10)
for (const platform of ['ios', 'android']) {
  assert.deepEqual(result.steps.filter(step => step.platform === platform).map(step => step.stepId), BUILDER_STEP_IDS[platform], 'step order matches canonical platform definitions')
  for (const step of result.steps.filter(step => step.platform === platform))
    assert.equal(step.title, messages[`builder-checklist-${platform}-${step.stepId}-title`])
}
assert.equal(result.steps.filter(step => step.platform === 'ios').length, 6)
assert.equal(result.steps.filter(step => step.platform === 'android').length, 4)
assert.equal(result.steps.find(step => step.id === 'builder.ios.start_setup').at, '2026-01-01T00:00:00Z')
assert.equal(result.steps.find(step => step.id === 'builder.ios.choose_destination').annotation, 'import_ad_hoc')
assert.equal(result.steps.find(step => step.id === 'builder.android.successful_cloud_build').status, 'warning')
const text = formatAppTodoList('com.example.builder', progress)
assert.match(text, /Builder checklist/)
assert.match(text, /iOS/)
assert.match(text, /Android \(selected\)/)
assert.match(text, /Cloud build failed/)
assert.match(text, /Ad Hoc/)
assert.match(text, /4\/10 completed/)
assert.match(text, /Next step: Connect Google Play/)
assert.match(text, /build init --platform android/)
assert.doesNotMatch(text, /Create a channel|Install Capgo Updater|first cloud build succeeded/i)
assert.equal(JSON.stringify(progress), before, 'reading/displaying progress preserves all state')
assert.match(text, /🍎 iOS/)
assert.match(text, /🤖 Android \(selected\)/)
assert.match(text, /install directly on registered devices/)
assert.match(text, /  Note: You chose Ad Hoc distribution:/)
assert.match(text, /  Warning: Cloud build failed\.\n           Open the build logs/)
assert.doesNotMatch(text, /\u001B\[/, 'plain output keeps labels without color codes')
const colored = formatAppTodoList('com.example.builder', progress, { color: true })
assert.match(colored, /\u001B\[1;36m🍎 iOS\u001B\[0m/)
assert.match(colored, /\u001B\[32m\[x\] Done\u001B\[0m/)
assert.match(colored, /\u001B\[33m\[ \] Pending\u001B\[0m/)
assert.match(colored, /\u001B\[31m\[!\] Warning\u001B\[0m/)
assert.match(colored, /\u001B\[2m\[-\] Skipped\u001B\[0m/)
assert.equal(colored.replace(/\u001B\[[0-9;]*m/g, ''), text, 'color changes styling only')
assert.doesNotMatch(formatAppTodoList('com.example.builder', progress, { color: false }), /\u001B\[/)
// Agents on an active trial get a plan item before the next step, worded for cloud builds.
process.env.TZ = 'UTC'
const trial = { endsAt: Date.parse('2026-01-15T12:00:00Z'), plansUrl: 'https://console.example.com/settings/organization/plans?oid=builder-org' }
const trialText = formatAppTodoList('com.example.builder', progress, { trial })
assert.ok(trialText.includes('\n\n[ ] Pending: Add a payment method before Jan 15, 2026 so cloud builds keep working after the free trial (no charge before then): https://console.example.com/settings/organization/plans?trial_card=1\n\nNext step: Connect Google Play'), trialText)
assert.equal(trialText.replace(/\n\n\[ \] Pending: Add a payment method[^\n]+/, ''), text, 'the trial item is the only addition')
assert.doesNotMatch(text, /payment method|trial_card/, 'the Builder checklist has no trial item unless an agent asks for one')
for (const [annotation, expected] of [
  ['asc_new', /guided setup.*TestFlight.*signing credentials/s],
  ['asc_new_auto', /selected automatically.*import.*requires macOS/s],
  ['import_app_store', /existing signing credentials.*App Store or TestFlight/s],
  ['import_ad_hoc', /install directly on registered devices.*without TestFlight/s],
  ['asc_key_verification_failed', /verify your App Store Connect API key.*check the key/s],
  ['ios_certificate_creation_failed', /could not create.*certificate.*retry/s],
  ['ios_certificate_limit_reached', /certificate limit.*reuse.*revoke/s],
  ['ios_certificate_export_failed', /could not export.*certificate.*private key/s],
  ['cloud_build_failed', /Cloud build failed.*build logs.*retry/s],
]) {
  const value = structuredClone(setup)
  value.steps.builder.ios.choose_destination.annotation = annotation
  const output = formatAppTodoList('com.example.builder', { onboarding: { setup: value } })
  if (annotation === 'asc_new')
    assert.match(output, /  Note: You chose guided setup for TestFlight\.\n        The CLI will help prepare your Apple signing credentials/)
  assert.match(output, expected, `${annotation} explains the choice or recovery action`)
  assert.ok(!output.includes(annotation), 'internal annotation codes stay out of the output')
}
const unknownNote = structuredClone(setup)
unknownNote.steps.builder.ios.choose_destination.annotation = 'future_internal_note'
assert.doesNotMatch(formatAppTodoList('com.example.builder', { onboarding: { setup: unknownNote } }), /future_internal_note|Note:/)
assert.equal(getAppTodoSteps({ onboarding: { setup: unknownNote } }).steps.find(step => step.id === 'builder.ios.choose_destination').annotation, 'future_internal_note', 'display changes preserve the saved annotation')

for (const patch of [
  { todo_list_version: '4' }, { todo_list_version: 3 },
  { builder_todo_list_version: 1 }, { builder_todo_list_version: '2' }, { builder_todo_list_version: undefined },
  { paths: undefined }, { paths: 'builder' }, { paths: [] }, { paths: ['ota'] },
  { paths: ['builder', 'ota'] }, { paths: ['builder', 'unknown'] }, { paths: ['builder', 'builder'] },
  { selected_path: 'ota' }, { selected_path: undefined },
  { ota_todo_list_version: '1' }, { ota_todo_list_version: null },
  { steps: undefined }, { steps: [] }, { steps: { builder: {} } },
  { steps: { builder: { ios: {}, android: [] } } },
  { steps: { ...setup.steps, ota: {} } },
]) {
  const actual = getAppTodoSteps({ onboarding: { setup: { ...setup, ...patch }, intent: 'builder' } })
  assert.notEqual(actual.path, 'builder', `rejects invalid assignment ${JSON.stringify(patch)}`)
}
for (const onboarding of [null, [], {}, { intent: 'builder' }, { setup: null }, { setup: [] }])
  assert.notEqual(getAppTodoSteps({ onboarding }).path, 'builder')
assert.equal(getAppTodoSteps({ onboarding: setup }).path, 'builder', 'supports existing unwrapped setup convention')

for (const paths of [['ota'], ['ota', 'builder']]) {
  const legacy = getAppTodoSteps({ onboarding: { setup: { ...setup, paths, ota_todo_list_version: '1', steps: { ...setup.steps, ota: { add_updater: { status: 'done' } } } } } })
  assert.equal(legacy.steps.length, 7, 'OTA-only and dual assignments retain their OTA checklist')
  assert.equal(legacy.steps.find(step => step.id === 'add_updater').status, 'done')
}
for (const selected of [undefined, 'web', null]) {
  const output = formatAppTodoList('com.example.builder', { onboarding: { setup: { ...setup, selected_builder_platform: selected } } })
  assert.match(output, /Choose a platform/)
  assert.doesNotMatch(output, /\(selected\)|Next step:/)
}
for (const status of ['pending', 'warning', 'done', 'skipped', 'invalid']) {
  const value = structuredClone(setup)
  value.steps.builder.android.successful_cloud_build.status = status
  const actual = getAppTodoSteps({ onboarding: { setup: value } }).steps.find(step => step.id === 'builder.android.successful_cloud_build')
  assert.equal(actual.status, status === 'invalid' ? 'pending' : status)
}
const selectedComplete = structuredClone(setup)
selectedComplete.steps.builder.android = Object.fromEntries(BUILDER_STEP_IDS.android.map(id => [id, { status: id === 'prepare_keystore' ? 'skipped' : 'done' }]))
const continueOther = formatAppTodoList('com.example.builder', { onboarding: { setup: selectedComplete } })
assert.match(continueOther, /Continue with 🍎 iOS/)
assert.match(continueOther, /build init --platform ios/)
assert.doesNotMatch(continueOther, /build init --platform android/)
assert.equal(selectedComplete.selected_builder_platform, 'android', 'guidance does not rewrite the saved selection')
for (const selected of [undefined, 'ios', 'android']) {
  const allComplete = structuredClone(selectedComplete)
  allComplete.selected_builder_platform = selected
  allComplete.steps.builder.ios = Object.fromEntries(BUILDER_STEP_IDS.ios.map(id => [id, { status: 'done' }]))
  const output = formatAppTodoList('com.example.builder', { onboarding: { setup: allComplete } })
  assert.match(output, /Both platform checklists are complete/)
  assert.doesNotMatch(output, /--platform|Next step:|other platform|Choose a platform/)
}
console.log('Builder-only assignment, per-platform progress, annotations, authoritative outcomes and OTA compatibility passed')

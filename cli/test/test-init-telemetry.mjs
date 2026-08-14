#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInitTelemetry, mergeInitProgressTelemetry, parseInitProgressTelemetry } from '../src/init/telemetry.ts'

console.log('🧪 Testing init telemetry context...\n')

const saved = { journey_id: 'ij_saved', last_run_id: 'ir_previous' }

function create(options = {}) {
  const events = []
  const telemetry = createInitTelemetry({
    capture: async (event, properties, icon) => events.push({ event, properties, icon }),
    replaySessionId: () => 'init-replay',
    ...options,
  })
  telemetry.setAuth('org', 'key')
  telemetry.setScope('app')
  return { events, telemetry }
}

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  assert.ok(firstIndex >= 0, `${message}: missing ${first}`)
  assert.ok(secondIndex >= 0, `${message}: missing ${second}`)
  assert.ok(firstIndex < secondIndex, message)
}

{
  const { events, telemetry } = create()
  const { events: noReplayEvents, telemetry: second } = create({ replaySessionId: () => undefined })
  assert.match(telemetry.runId, /^ir_/, 'each run has an immutable run ID')
  assert.match(telemetry.journeyId, /^ij_/, 'each run starts with a fresh journey ID')
  assert.notEqual(telemetry.runId, second.runId, 'runs are unique per invocation')
  assert.notEqual(telemetry.journeyId, second.journeyId, 'journeys are unique per invocation')
  await telemetry.recordMilestone('onboarding-step-done')
  await second.recordMilestone('onboarding-step-done')
  assert.deepEqual(events[0].properties, {
    onboarding_event_version: 1,
    onboarding_journey_id: telemetry.journeyId,
    onboarding_run_id: telemetry.runId,
    $session_id: 'init-replay',
  }, 'milestones share run, journey, and active replay correlation')
  assert.equal('$session_id' in noReplayEvents[0].properties, false, 'events omit inactive replay correlation')
}

{
  const { events, telemetry } = create()
  const initialJourneyId = telemetry.journeyId
  telemetry.prepareResumeCandidate(saved, 2, 12)
  await telemetry.recordRunStarted()
  await telemetry.recordResumePromptViewed()
  await telemetry.recordResumeDecision('continue')
  assert.equal(telemetry.journeyId, saved.journey_id, 'continue switches to the saved journey')
  assert.equal(events[1].properties.total_steps, 12, 'resume prompts include the total step count')
  assert.deepEqual(events[2].properties, {
    onboarding_event_version: 1,
    onboarding_journey_id: saved.journey_id,
    onboarding_run_id: telemetry.runId,
    $session_id: 'init-replay',
    initial_journey_id: initialJourneyId,
    resume_journey_id: saved.journey_id,
    resumed_from_run_id: saved.last_run_id,
    saved_step: 2,
    choice: 'continue',
  })
  assert.deepEqual(telemetry.getProgressMetadata(), { journey_id: saved.journey_id, last_run_id: telemetry.runId })

  const second = create()
  second.telemetry.prepareResumeCandidate(telemetry.getProgressMetadata(), 2, 12)
  await second.telemetry.recordResumeDecision('continue')
  assert.equal(second.telemetry.journeyId, saved.journey_id, 'accepted resumes retain the saved journey')
  assert.equal(second.events[0].properties.resumed_from_run_id, telemetry.runId, 'next resume references the immediately previous run')
}

{
  const { events, telemetry } = create()
  const initialJourneyId = telemetry.journeyId
  telemetry.prepareResumeCandidate(saved, 2, 12)
  await telemetry.recordResumeDecision('restart')
  assert.equal(telemetry.journeyId, initialJourneyId, 'restart keeps the fresh journey')
}

{
  const { telemetry } = create()
  const backfill = telemetry.prepareResumeCandidate(undefined, 2, 12)
  assert.match(backfill.journey_id, /^ij_/, 'legacy progress receives a generated stable journey')
  assert.deepEqual(telemetry.getLegacyBackfillMetadata(), { journey_id: backfill.journey_id })
}

{
  const { events, telemetry } = create({ enabled: false })
  telemetry.prepareResumeCandidate(saved, 2, 12)
  await telemetry.recordRunStarted()
  await telemetry.recordResumeDecision('continue')
  assert.deepEqual(events, [], 'disabled telemetry emits nothing')
  assert.deepEqual(telemetry.getProgressMetadata(), saved, 'disabled accepted resumes preserve saved metadata without advancing it')
  assert.equal(telemetry.getLegacyBackfillMetadata(), undefined, 'disabled telemetry does not backfill legacy progress')
}

{
  const progress = { app_id: 'com.example.app', step_done: 2, telemetry: { journey_id: 'bad' } }
  assert.equal(parseInitProgressTelemetry(progress), undefined, 'malformed nested telemetry is ignored')
  const mixedProgress = { ...progress, telemetry: { journey_id: 'ij_saved', last_run_id: 'invalid' } }
  const mixedTelemetry = parseInitProgressTelemetry(mixedProgress)
  assert.deepEqual(mixedTelemetry, { journey_id: 'ij_saved' }, 'a malformed optional run ID does not discard a valid journey')
  const { telemetry } = create({ enabled: false })
  telemetry.prepareResumeCandidate(mixedTelemetry, 2, 12)
  await telemetry.recordRunStarted()
  await telemetry.recordResumeDecision('continue')
  assert.deepEqual(telemetry.getProgressMetadata(), { journey_id: 'ij_saved' }, 'disabled accepted resumes preserve a valid journey without advancing its run ID')
  assert.deepEqual(mergeInitProgressTelemetry(progress, saved), { ...progress, telemetry: saved }, 'telemetry merge preserves operational progress fields')
}

{
  const { events, telemetry } = create()
  await telemetry.recordRunStarted()
  await telemetry.recordRunStarted()
  await telemetry.recordRunEnded('completed', 0)
  await telemetry.recordRunEnded('completed', 0)
  assert.deepEqual(events.map(event => event.event), ['onboarding-run-started', 'onboarding-run-ended'], 'lifecycle events are emitted once')
}

{
  const { events, telemetry } = create()
  await telemetry.recordMilestone('canceled', undefined, '🤷')
  assert.equal(events[0].icon, '🤷', 'milestones preserve their icon through injected capture')
}

{
  const command = readFileSync(new URL('../src/init/command.ts', import.meta.url), 'utf8')
  const resume = command.slice(command.indexOf('async function tryResumeOnboarding'), command.indexOf('\nfunction cleanupStepsDone'))
  const markStepDone = command.slice(command.indexOf('function markStepDone'), command.indexOf('\ninterface ResumeResult'))
  const initApp = command.slice(command.indexOf('export async function initApp'))
  const markInitSnag = command.slice(command.indexOf('async function markInitSnag'), command.indexOf('\nasync function markStep'))
  const exitAfterFinishingReplay = command.slice(command.indexOf('async function exitAfterFinishingReplay'), command.indexOf('\nconst frameworkSetupGuides'))
  const allExitCalls = [...command.matchAll(/(?<!function )exitAfterFinishingReplay\([^)]*\)/g)]
  const exitCalls = [...command.matchAll(/(?<!function )exitAfterFinishingReplay\('(completed|cancelled|failed)', (0|1)\)/g)]

  assert.ok(command.includes("import { createInitTelemetry, mergeInitProgressTelemetry, parseInitProgressTelemetry } from './telemetry'"), 'classic init imports telemetry helpers')
  assert.ok(command.includes('let activeInitTelemetry: ReturnType<typeof createInitTelemetry> | undefined'), 'classic init owns one active telemetry context')
  assertBefore(initApp, "activeInitTelemetry?.setAuth('', options.apikey)", 'let resumed = await tryResumeOnboarding', 'authentication is set before no-resume lifecycle telemetry')
  assertBefore(initApp, 'let resumed = await tryResumeOnboarding', 'await activeInitTelemetry?.recordRunStarted()', 'fresh paths record a run after resume detection')
  assert.ok(resume.indexOf('parseInitProgressTelemetry(progress)') >= 0, 'resume parses nested telemetry from the full saved progress object')
  assertBefore(resume, 'prepareResumeCandidate(savedTelemetry, step_done, initOnboardingSteps.length)', 'await activeInitTelemetry?.recordRunStarted()', 'resume candidate precedes lifecycle start')
  assertBefore(resume, 'await activeInitTelemetry?.recordRunStarted()', 'await activeInitTelemetry?.recordResumePromptViewed()', 'resume lifecycle start precedes prompt telemetry')
  assertBefore(resume, 'await activeInitTelemetry?.recordResumePromptViewed()', 'const resumeChoice = await pSelect', 'resume prompt telemetry precedes the resume selector')
  const continueBranch = resume.slice(resume.indexOf("if (resumeChoice === 'yes')"), resume.indexOf('// User chose to start over'))
  assertBefore(continueBranch, "recordResumeDecision('continue')", 'getProgressMetadata()', 'continue records its decision before reading progress telemetry')
  assertBefore(continueBranch, 'getProgressMetadata()', 'writeFileSync(getTmpObjectPath(), JSON.stringify(mergeInitProgressTelemetry(progress, progressMetadata)))', 'continue persists current telemetry immediately after reading it')
  assertBefore(continueBranch, 'writeFileSync(getTmpObjectPath(), JSON.stringify(mergeInitProgressTelemetry(progress, progressMetadata)))', 'const resumedTargets = resolveResumedInitTargets', 'continue persists telemetry before restoring targets')
  const restartBranch = resume.slice(resume.indexOf('// User chose to start over'))
  assertBefore(restartBranch, "recordResumeDecision('restart')", 'clearScope()', 'restart records its decision before clearing scope')
  assertBefore(restartBranch, 'clearScope()', 'cleanupStepsDone()', 'restart clears scope before cleanup')
  assert.ok(markStepDone.indexOf('const progress = {') >= 0 && markStepDone.indexOf('mergeInitProgressTelemetry(progress, activeInitTelemetry?.getProgressMetadata())') >= 0, 'checkpoints merge telemetry into the existing operational progress payload')
  assert.ok(markInitSnag.includes('activeInitTelemetry?.setAuth(orgId, apikey)'), 'classic milestones set active authentication')
  assert.ok(markInitSnag.includes('activeInitTelemetry?.setScope(appId)'), 'classic milestones set active app scope')
  assert.ok(markInitSnag.includes('activeInitTelemetry.recordMilestone(event, undefined, icon)'), 'classic milestones use the telemetry context and preserve their icon')
  assert.ok(markInitSnag.includes("return markSnag('onboarding-v2', orgId, apikey, event, appId, icon"), 'classic milestones retain the isolated markSnag fallback')
  assert.doesNotMatch(command, /exitAfterFinishingReplay\((?:\d+)?\)/, 'shared exits do not use bare or numeric-only calls')
  assert.equal(allExitCalls.length, 24, 'only 24 shared exits call the lifecycle helper')
  assert.equal(exitCalls.length, 24, 'every shared exit has an explicit outcome and code')
  assert.equal(exitCalls.filter(([, outcome, code]) => outcome === 'completed' && code === '0').length, 1, 'only final onboarding completion is completed')
  assert.equal(exitCalls.filter(([, outcome, code]) => outcome === 'failed' && code === '1').length, 2, 'only template and onboarding failures are failed')
  assert.equal(exitCalls.filter(([, outcome, code]) => outcome === 'cancelled' && code === '0').length, 14, 'zero-code non-completions remain cancelled')
  assert.equal(exitCalls.filter(([, outcome, code]) => outcome === 'cancelled' && code === '1').length, 7, 'one-code non-failures remain cancelled')
  assertBefore(exitAfterFinishingReplay, 'recordRunEnded(outcome, code)', 'finishActiveCliReplay()', 'run end is recorded before replay finishes')
}

console.log('✅ Init telemetry context tests passed')

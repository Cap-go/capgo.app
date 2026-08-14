#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createInitTelemetry, mergeInitProgressTelemetry, parseInitProgressTelemetry } from '../src/init/telemetry.ts'

console.log('🧪 Testing init telemetry context...\n')

const saved = { journey_id: 'ij_saved', last_run_id: 'ir_previous' }

function create(options = {}) {
  const events = []
  const telemetry = createInitTelemetry({
    capture: async (event, properties) => events.push({ event, properties }),
    replaySessionId: () => 'init-replay',
    ...options,
  })
  telemetry.setAuth('org', 'key')
  telemetry.setScope('app')
  return { events, telemetry }
}

{
  const { events, telemetry } = create()
  assert.match(telemetry.runId, /^ir_/, 'each run has an immutable run ID')
  assert.match(telemetry.journeyId, /^ij_/, 'each run starts with a fresh journey ID')
  await telemetry.recordMilestone('onboarding-step-done')
  assert.deepEqual(events[0].properties, {
    onboarding_event_version: 1,
    onboarding_journey_id: telemetry.journeyId,
    onboarding_run_id: telemetry.runId,
    $session_id: 'init-replay',
  }, 'milestones share run, journey, and active replay correlation')
}

{
  const { events, telemetry } = create()
  const initialJourneyId = telemetry.journeyId
  telemetry.prepareResumeCandidate(saved, 2, 12)
  await telemetry.recordRunStarted()
  await telemetry.recordResumePromptViewed()
  await telemetry.recordResumeDecision('continue')
  assert.equal(telemetry.journeyId, saved.journey_id, 'continue switches to the saved journey')
  assert.deepEqual(events.map(event => event.event), ['onboarding-run-started', 'onboarding-resume-prompt-viewed', 'onboarding-resume-decision'])
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
  assert.equal(events[0].properties.initial_journey_id, undefined, 'restart does not report an initial journey switch')
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

console.log('✅ Init telemetry context tests passed')

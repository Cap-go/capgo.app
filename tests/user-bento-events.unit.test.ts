import type { StoredUserBentoEvents } from '../supabase/functions/_backend/utils/user_bento_events.ts'
import { describe, expect, it } from 'vitest'
import {
  appendUserBentoObservation,
  buildMappedUserBentoEvent,
  getPendingUserBentoEvents,
  parseUserBentoEvents,
} from '../supabase/functions/_backend/utils/user_bento_events.ts'

describe('cli user Bento event registry', () => {
  it.each([
    ['CLI Command Invoked', 'cli:command_invoked'],
    ['User CLI login', 'cli:login_successful'],
    ['onboarding-run-started', 'cli:onboarding_run_started'],
  ])('maps %s to %s', (sourceEvent, bentoEvent) => {
    expect(buildMappedUserBentoEvent({
      sourceEvent,
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {},
    })?.bentoEvent).toBe(bentoEvent)
  })

  it('maps every frontend onboarding restart with only allowlisted details', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'onboarding_resume_restarted',
      observedAt: '2026-08-23T12:00:00.000Z',
      tags: {
        flow: 'pre_org',
        onboarding_attempt_id: '84c27b64-9c96-4a05-b614-d63200b25799',
        onboarding_run_id: 'run-new',
        onboarding_version: 4,
        resume_onboarding_attempt_id: '020acb55-8e96-44bb-8335-a7fc2379ea86',
        resumed_from_run_id: 'run-old',
        saved_step: 'organization',
        secret: 'must-not-leak',
        step_index: 2,
        total_steps: 4,
      },
    })).toEqual({
      bentoEvent: 'onboarding:resume_restarted',
      delivery: 'every',
      details: {
        flow: 'pre_org',
        observed_at: '2026-08-23T12:00:00.000Z',
        onboarding_attempt_id: '84c27b64-9c96-4a05-b614-d63200b25799',
        onboarding_run_id: 'run-new',
        onboarding_version: 4,
        resume_onboarding_attempt_id: '020acb55-8e96-44bb-8335-a7fc2379ea86',
        resumed_from_run_id: 'run-old',
        saved_step: 'organization',
        source_event: 'onboarding_resume_restarted',
        step_index: 2,
        total_steps: 4,
      },
    })
  })

  it('drops malformed onboarding attempt IDs', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'onboarding_resume_restarted',
      observedAt: '2026-08-23T12:00:00.000Z',
      tags: {
        flow: 'pre_org',
        onboarding_attempt_id: 'not-a-uuid',
        resume_onboarding_attempt_id: 'also-not-a-uuid',
      },
    })?.details).toEqual({
      flow: 'pre_org',
      observed_at: '2026-08-23T12:00:00.000Z',
      source_event: 'onboarding_resume_restarted',
    })
  })

  it('returns undefined for an unmapped event', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'CLI Command Succeeded',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: { command_path: 'init' },
    })).toBeUndefined()
  })

  it('copies only typed and bounded allowlisted command details', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:00.000Z',
      orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      appId: 'com.example.app',
      tags: {
        command_path: 'init',
        flags: 'verbose',
        flags_count: 1,
        positional_arg_count: 0,
        secret: 'must-not-leak',
      },
    })?.details).toEqual({
      observed_at: '2026-08-22T10:00:00.000Z',
      source_event: 'CLI Command Invoked',
      org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      app_id: 'com.example.app',
      command_path: 'init',
      flags: 'verbose',
      flags_count: 1,
      positional_arg_count: 0,
    })
  })

  it('retains the first and four latest details while count keeps growing', () => {
    let events: StoredUserBentoEvents = {}
    for (let index = 1; index <= 7; index++) {
      const observation = buildMappedUserBentoEvent({
        sourceEvent: 'CLI Command Invoked',
        observedAt: `2026-08-22T10:00:0${index}.000Z`,
        tags: { command_path: `command-${index}` },
      })!
      events = appendUserBentoObservation(events, observation)
    }

    expect(events['cli:command_invoked']?.occurrence_count).toBe(7)
    expect(events['cli:command_invoked']?.details.map(detail => detail.command_path)).toEqual([
      'command-1',
      'command-4',
      'command-5',
      'command-6',
      'command-7',
    ])
  })

  it('does not append after a valid sent_at', () => {
    const observation = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {},
    })!
    const sent = parseUserBentoEvents({
      bento_events: {
        'cli:login_successful': {
          details: [observation.details],
          occurrence_count: 1,
          sent_at: '2026-08-22T10:00:01.000Z',
        },
      },
    })

    expect(appendUserBentoObservation(sent, observation)).toBe(sent)
  })

  it('does not trust malformed sent_at and leaves the event pending', () => {
    const observation = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {},
    })!
    const malformed = parseUserBentoEvents({
      bento_events: {
        'cli:login_successful': {
          details: [observation.details],
          occurrence_count: 1,
          sent_at: 'not-a-date',
        },
      },
    })

    expect(getPendingUserBentoEvents(malformed)).toEqual([
      { event: 'cli:login_successful', state: malformed['cli:login_successful'] },
    ])
  })

  it('appends to a direct stored state with malformed sent_at', () => {
    const first = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:00.000Z',
    })!
    const second = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:01.000Z',
    })!
    const events: StoredUserBentoEvents = {
      'cli:login_successful': {
        details: [first.details],
        occurrence_count: 1,
        sent_at: 'not-a-date',
      },
    }

    expect(appendUserBentoObservation(events, second)).toEqual({
      'cli:login_successful': {
        details: [first.details, second.details],
        occurrence_count: 2,
      },
    })
  })

  it('keeps a direct stored state with malformed sent_at pending', () => {
    const observation = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:00.000Z',
    })!
    const state = {
      details: [observation.details],
      occurrence_count: 1,
      sent_at: 'not-a-date',
    }
    const events: StoredUserBentoEvents = {
      'cli:login_successful': state,
    }

    expect(getPendingUserBentoEvents(events)).toEqual([
      { event: 'cli:login_successful', state },
    ])
  })

  it.each([
    ['negative', -1, 0, 1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1, 0, 1],
    ['undercounted', 1, 3, 4],
  ])('normalizes %s occurrence_count before append', (_, occurrenceCount, detailCount, expectedCount) => {
    const details = Array.from({ length: detailCount }, (_, index) => buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: `2026-08-22T10:00:0${index}.000Z`,
    })!.details)
    const observation = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:09.000Z',
    })!
    const events: StoredUserBentoEvents = {
      'cli:login_successful': {
        details,
        occurrence_count: occurrenceCount,
      },
    }

    expect(appendUserBentoObservation(events, observation)['cli:login_successful']?.occurrence_count)
      .toBe(expectedCount)
  })

  it('drops unknown stored events and unknown stored detail properties', () => {
    const parsed = parseUserBentoEvents({
      bento_events: {
        'cli:command_invoked': {
          occurrence_count: 1,
          details: [{
            observed_at: '2026-08-22T10:00:00.000Z',
            source_event: 'attacker-controlled',
            command_path: 'init',
            api_key: 'must-not-leak',
            token: 'must-not-leak',
          }],
        },
        'attacker:event': {
          occurrence_count: 1,
          details: [{ token: 'must-not-leak' }],
        },
      },
    })

    expect(parsed).toEqual({
      'cli:command_invoked': {
        occurrence_count: 1,
        details: [{
          observed_at: '2026-08-22T10:00:00.000Z',
          source_event: 'CLI Command Invoked',
          command_path: 'init',
        }],
      },
    })
  })

  it('requires exact ISO timestamps when building and parsing observations', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T12:00:00+02:00',
    })).toBeUndefined()

    expect(parseUserBentoEvents({
      bento_events: {
        'cli:login_successful': {
          occurrence_count: 1,
          details: [{
            observed_at: '2026-08-22T12:00:00+02:00',
            source_event: 'User CLI login',
          }],
        },
      },
    })).toEqual({})
  })

  it('enforces descriptor types, ranges, and Unicode-safe string bounds', () => {
    const commandPath = '🚀'.repeat(128)
    const details = buildMappedUserBentoEvent({
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:00.000Z',
      orgId: 'o'.repeat(65),
      appId: 'a'.repeat(256),
      tags: {
        command_path: `${commandPath}💥`,
        flags: '',
        flags_count: 129,
        positional_arg_count: 0.5,
      },
    })?.details

    expect(details).toEqual({
      observed_at: '2026-08-22T10:00:00.000Z',
      source_event: 'CLI Command Invoked',
      org_id: 'o'.repeat(64),
      app_id: 'a'.repeat(255),
      command_path: commandPath,
    })
    expect(Array.from(details?.command_path as string)).toHaveLength(128)
  })

  it('copies every typed onboarding field and rejects invalid values', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'onboarding-run-started',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {
        onboarding_event_version: 1,
        onboarding_journey_id: 'journey',
        onboarding_run_id: 'run',
        resume_available: true,
        resume_journey_id: 'resume-journey',
        resumed_from_run_id: 'prior-run',
        saved_step: 0,
        total_steps: 1000,
      },
    })?.details).toEqual({
      observed_at: '2026-08-22T10:00:00.000Z',
      source_event: 'onboarding-run-started',
      onboarding_event_version: 1,
      onboarding_journey_id: 'journey',
      onboarding_run_id: 'run',
      resume_available: true,
      resume_journey_id: 'resume-journey',
      resumed_from_run_id: 'prior-run',
      saved_step: 0,
      total_steps: 1000,
    })

    expect(buildMappedUserBentoEvent({
      sourceEvent: 'onboarding-run-started',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {
        onboarding_event_version: 0,
        resume_available: 'true',
        saved_step: -1,
        total_steps: 1001,
      },
    })?.details).toEqual({
      observed_at: '2026-08-22T10:00:00.000Z',
      source_event: 'onboarding-run-started',
    })
  })

  it('sanitizes stored details, caps them, and reconciles occurrence counts', () => {
    const detail = (index: number) => ({
      observed_at: `2026-08-22T10:00:0${index}.000Z`,
      source_event: 'untrusted',
      command_path: `command-${index}`,
    })
    const parsed = parseUserBentoEvents({
      bento_events: {
        'cli:command_invoked': {
          occurrence_count: 2,
          details: Array.from({ length: 7 }, (_, index) => detail(index + 1)),
        },
      },
    })

    expect(parsed['cli:command_invoked']).toEqual({
      occurrence_count: 7,
      details: [detail(1), detail(4), detail(5), detail(6), detail(7)].map(value => ({
        ...value,
        source_event: 'CLI Command Invoked',
      })),
    })
  })

  it('preserves a valid sent state without details and drops empty pending states', () => {
    expect(parseUserBentoEvents({
      bento_events: {
        'cli:login_successful': {
          occurrence_count: -1,
          details: [],
          sent_at: '2026-08-22T10:00:01.000Z',
        },
        'cli:onboarding_run_started': {
          occurrence_count: Number.MAX_SAFE_INTEGER + 1,
          details: [],
        },
      },
    })).toEqual({
      'cli:login_successful': {
        occurrence_count: 0,
        details: [],
        sent_at: '2026-08-22T10:00:01.000Z',
      },
    })
  })

  it('returns pending events in registry order', () => {
    const events = parseUserBentoEvents({
      bento_events: {
        'cli:onboarding_run_started': {
          occurrence_count: 1,
          details: [{
            observed_at: '2026-08-22T10:00:02.000Z',
            source_event: 'onboarding-run-started',
          }],
        },
        'cli:command_invoked': {
          occurrence_count: 1,
          details: [{
            observed_at: '2026-08-22T10:00:00.000Z',
            source_event: 'CLI Command Invoked',
            command_path: 'init',
          }],
        },
        'cli:login_successful': {
          occurrence_count: 1,
          details: [{
            observed_at: '2026-08-22T10:00:01.000Z',
            source_event: 'User CLI login',
          }],
        },
      },
    })

    expect(getPendingUserBentoEvents(events).map(({ event }) => event)).toEqual([
      'cli:command_invoked',
      'cli:login_successful',
      'cli:onboarding_run_started',
    ])
  })

  it('increments safely at the maximum count without mutating other event states', () => {
    const observation = buildMappedUserBentoEvent({
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:01.000Z',
      tags: { command_path: 'second' },
    })!
    const loginState = {
      occurrence_count: 1,
      details: [{
        observed_at: '2026-08-22T10:00:00.000Z',
        source_event: 'User CLI login',
      }],
    }
    const events: StoredUserBentoEvents = {
      'cli:command_invoked': {
        occurrence_count: Number.MAX_SAFE_INTEGER,
        details: [{
          observed_at: '2026-08-22T10:00:00.000Z',
          source_event: 'CLI Command Invoked',
          command_path: 'first',
        }],
      },
      'cli:login_successful': loginState,
    }

    const appended = appendUserBentoObservation(events, observation)

    expect(appended).not.toBe(events)
    expect(appended['cli:command_invoked']?.occurrence_count).toBe(Number.MAX_SAFE_INTEGER)
    expect(appended['cli:login_successful']).toBe(loginState)
    expect(events['cli:command_invoked']?.details).toHaveLength(1)
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, executeSQL, getEndpointUrl, ORG_ID, USER_PASSWORD_HASH } from './test-utils.ts'

interface OnboardingRow {
  onboarding: Record<string, unknown> & {
    bento_events?: Record<string, {
      details: Array<Record<string, unknown>>
      occurrence_count: number
      sent_at?: string
    }>
  }
}

const userId = randomUUID()
const email = `user-bento-events-${randomUUID()}@test.com`
const verifiedAppId = 'com.demo.app'
let apiKey: string | undefined
let apiKeyId: number | undefined

beforeAll(async () => {
  await executeSQL(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
     VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)`,
    [userId, email, USER_PASSWORD_HASH],
  )
  await executeSQL(
    `INSERT INTO public.users (id, email)
     VALUES ($1, $2)`,
    [userId, email],
  )

  const createdApiKey = await createDirectApiKeyWithBindings({
    userId,
    key: randomUUID(),
    name: 'user-bento-events',
    orgId: ORG_ID,
  })
  if (!createdApiKey.key)
    throw new Error('Expected plain API key from createDirectApiKeyWithBindings')
  apiKey = createdApiKey.key
  apiKeyId = createdApiKey.id
})

afterAll(async () => {
  if (apiKeyId !== undefined)
    await executeSQL('DELETE FROM public.apikeys WHERE id = $1', [apiKeyId])
  await executeSQL('DELETE FROM public.users WHERE id = $1', [userId])
  await executeSQL('DELETE FROM auth.users WHERE id = $1', [userId])
})

async function postEvent(body: Record<string, unknown>) {
  if (!apiKey)
    throw new Error('API key was not initialized')

  return fetch(getEndpointUrl('/private/events'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'capgkey': apiKey,
    },
    body: JSON.stringify(body),
  })
}

async function readOnboarding() {
  const onboarding = await readOnboardingForUser(userId)
  if (!onboarding)
    throw new Error('Expected dedicated user onboarding row')
  return onboarding
}

async function readOnboardingForUser(targetUserId: string) {
  const rows = await executeSQL<OnboardingRow>(
    'SELECT onboarding FROM public.users WHERE id = $1',
    [targetUserId],
  )
  return rows[0]?.onboarding
}

async function setOnboarding(onboarding: Record<string, unknown>) {
  await executeSQL(
    'UPDATE public.users SET onboarding = $2::jsonb WHERE id = $1',
    [userId, JSON.stringify(onboarding)],
  )
}

it('keeps notifyConsole login events out of the user Bento state', async () => {
  const response = await postEvent({
    channel: 'user-login',
    event: 'User CLI login',
    notifyConsole: true,
    user_id: ORG_ID,
    tracking_version: 2,
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
  expect(await readOnboarding()).not.toHaveProperty('bento_events')
})

it('records legacy org-scoped events on the authenticated actor', async () => {
  await setOnboarding({ legacy_actor: { keep: true } })

  const response = await postEvent({
    channel: 'user-login',
    event: 'User CLI login',
    user_id: ORG_ID,
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
  expect(await readOnboarding()).toMatchObject({
    legacy_actor: { keep: true },
    bento_events: {
      'cli:login_successful': {
        occurrence_count: 1,
        details: [expect.objectContaining({ org_id: ORG_ID })],
      },
    },
  })
  expect(await readOnboardingForUser(ORG_ID)).toBeUndefined()
})

it('omits an unverified app id from actor Bento event details', async () => {
  await setOnboarding({ unverified_app: { keep: true } })

  const response = await postEvent({
    channel: 'cli-usage',
    event: 'CLI Command Invoked',
    tracking_version: 2,
    tags: {
      app_id: verifiedAppId,
      command_path: 'init',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
  const onboarding = await readOnboarding()
  expect(onboarding).toMatchObject({ unverified_app: { keep: true } })
  const commandDetail = onboarding.bento_events?.['cli:command_invoked']?.details[0]
  expect(commandDetail).toMatchObject({ command_path: 'init' })
  expect(commandDetail).not.toHaveProperty('app_id')
})

it('keeps a verified app id in actor Bento event details', async () => {
  await setOnboarding({ verified_app: { keep: true } })

  const response = await postEvent({
    channel: 'cli-usage',
    event: 'CLI Command Invoked',
    org_id: ORG_ID,
    tracking_version: 2,
    tags: {
      app_id: verifiedAppId,
      command_path: 'init',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
  expect(await readOnboarding()).toMatchObject({
    verified_app: { keep: true },
    bento_events: {
      'cli:command_invoked': {
        occurrence_count: 1,
        details: [expect.objectContaining({
          app_id: verifiedAppId,
          org_id: ORG_ID,
        })],
      },
    },
  })
})

it('records only mapped CLI Bento events for the authenticated actor', async () => {
  const initialOnboarding = {
    status: 'in_progress',
    step: 'details',
    flow: 'pre_org',
    unrelated: { keep: true },
  }
  await setOnboarding(initialOnboarding)

  const payloads = [
    {
      channel: 'cli-usage',
      event: 'CLI Command Invoked',
      org_id: ORG_ID,
      tracking_version: 2,
      tags: {
        command_path: 'init',
        flags: 'verbose',
        flags_count: 1,
        positional_arg_count: 0,
      },
    },
    {
      channel: 'user-login',
      event: 'User CLI login',
      org_id: ORG_ID,
      tracking_version: 2,
    },
    {
      channel: 'onboarding-v2',
      event: 'onboarding-run-started',
      org_id: ORG_ID,
      tracking_version: 2,
      tags: {
        onboarding_event_version: 1,
        onboarding_journey_id: 'ij_11111111-1111-4111-8111-111111111111',
        onboarding_run_id: 'ir_22222222-2222-4222-8222-222222222222',
        resume_available: false,
      },
    },
    {
      channel: 'cli-usage',
      event: 'CLI Command Succeeded',
      org_id: ORG_ID,
      tracking_version: 2,
    },
  ]

  for (const payload of payloads) {
    const response = await postEvent(payload)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  }

  const onboarding = await readOnboarding()
  expect(onboarding).toMatchObject(initialOnboarding)

  const bentoEvents = onboarding.bento_events!
  expect(Object.keys(bentoEvents).sort()).toEqual([
    'cli:command_invoked',
    'cli:login_successful',
    'cli:onboarding_run_started',
  ])
  expect(bentoEvents['cli:command_invoked']).toMatchObject({
    occurrence_count: 1,
    details: [expect.objectContaining({ command_path: 'init' })],
  })
  for (const event of Object.values(bentoEvents))
    expect(event).not.toHaveProperty('sent_at')
})

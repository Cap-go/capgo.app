import { describe, expect, it } from 'vitest'
import {
  addAppCreatorToOnboarding,
  buildAppCreatorEventDetails,
  getAppCreatorUserId,
} from '../supabase/functions/_backend/utils/app_creator.ts'

const creatorUserId = '6aa76066-55ef-4238-ade6-0b32334a4097'

describe('app creator metadata', () => {
  it.concurrent('stores the authenticated creator without dropping onboarding state', () => {
    const onboarding = addAppCreatorToOnboarding({
      features: { ota: { stage: 'local_only' } },
    }, creatorUserId, 'creator@capgo.app')

    expect(onboarding).toEqual({
      created_by_email: 'creator@capgo.app',
      created_by_user_id: creatorUserId,
      features: { ota: { stage: 'local_only' } },
    })
    expect(getAppCreatorUserId(onboarding)).toBe(creatorUserId)
  })

  it.concurrent('builds Bento event details with the creator id and email', () => {
    expect(buildAppCreatorEventDetails({
      created_by_email: 'creator@capgo.app',
      created_by_user_id: creatorUserId,
    })).toEqual({
      created_by_user_id: creatorUserId,
      created_by_email: 'creator@capgo.app',
    })
  })

  it.concurrent('omits invalid or missing creator metadata', () => {
    expect(getAppCreatorUserId({ created_by_user_id: 'not-a-user-id' })).toBeUndefined()
    expect(buildAppCreatorEventDetails({ created_by_email: 'creator@capgo.app' })).toEqual({})
  })
})

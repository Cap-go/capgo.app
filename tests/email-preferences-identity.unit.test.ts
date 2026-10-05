import { describe, expect, it } from 'vitest'
import { isVisitorUuid, parseEmailPreferencesQuery } from '../src/utils/emailPreferencesIdentity'

const VISITOR_UUID = '11111111-1111-4111-8111-111111111111'

describe('emailPreferencesIdentity', () => {
  it('treats uuid query param as visitor uuid', () => {
    expect(parseEmailPreferencesQuery({ uuid: VISITOR_UUID })).toEqual({
      email: '',
      visitorUuid: VISITOR_UUID,
    })
  })

  it('does not put a visitor uuid in the email field when sent as legacy email param', () => {
    expect(parseEmailPreferencesQuery({ email: VISITOR_UUID })).toEqual({
      email: '',
      visitorUuid: VISITOR_UUID,
    })
  })

  it('keeps a real email when email param is an address', () => {
    expect(parseEmailPreferencesQuery({ email: 'user@example.com' })).toEqual({
      email: 'user@example.com',
      visitorUuid: '',
    })
  })

  it('prefers explicit uuid param over email param', () => {
    const otherUuid = '22222222-2222-4222-8222-222222222222'
    expect(parseEmailPreferencesQuery({ uuid: VISITOR_UUID, email: otherUuid })).toEqual({
      email: '',
      visitorUuid: VISITOR_UUID,
    })
  })

  it('accepts id query param when it is a visitor uuid', () => {
    expect(parseEmailPreferencesQuery({ id: VISITOR_UUID })).toEqual({
      email: '',
      visitorUuid: VISITOR_UUID,
    })
  })

  it('classifies visitor uuids', () => {
    expect(isVisitorUuid(VISITOR_UUID)).toBe(true)
    expect(isVisitorUuid('user@example.com')).toBe(false)
  })

  it('uses the first value when a query key is repeated', () => {
    const secondUuid = '22222222-2222-4222-8222-222222222222'
    expect(parseEmailPreferencesQuery({ email: [VISITOR_UUID, secondUuid] })).toEqual({
      email: '',
      visitorUuid: VISITOR_UUID,
    })
  })
})

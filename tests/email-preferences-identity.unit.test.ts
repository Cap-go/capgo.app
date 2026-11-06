import { describe, expect, it } from 'vitest'
import { isVisitorUuid, parseEmailPreferencesQuery } from '../src/utils/emailPreferencesIdentity'

const VISITOR_UUID = '11111111-1111-4111-8111-111111111111'
const VISITOR_UUID_HEX = '11111111111141118111111111111111'
const OTHER_UUID = '22222222-2222-4222-8222-222222222222'

describe('emailPreferencesIdentity', () => {
  it.each([
    ['uuid param as visitor uuid', { uuid: VISITOR_UUID }, VISITOR_UUID],
    ['visitor uuid sent as legacy email param', { email: VISITOR_UUID }, VISITOR_UUID],
    ['explicit uuid param over email param', { uuid: VISITOR_UUID, email: OTHER_UUID }, VISITOR_UUID],
    ['id param when it is a visitor uuid', { id: VISITOR_UUID }, VISITOR_UUID],
    ['32-hex visitor id in uuid param', { uuid: VISITOR_UUID_HEX }, VISITOR_UUID_HEX],
    ['32-hex visitor id in legacy email param', { email: VISITOR_UUID_HEX }, VISITOR_UUID_HEX],
    ['first value of a repeated query key', { email: [VISITOR_UUID, OTHER_UUID] }, VISITOR_UUID],
  ])('reads %s without putting it in the email field', (_label, query, visitorUuid) => {
    expect(parseEmailPreferencesQuery(query)).toEqual({ email: '', visitorUuid })
  })

  it('keeps a real email when email param is an address', () => {
    expect(parseEmailPreferencesQuery({ email: 'user@example.com' })).toEqual({
      email: 'user@example.com',
      visitorUuid: '',
    })
  })

  it('classifies visitor uuids', () => {
    expect(isVisitorUuid(VISITOR_UUID)).toBe(true)
    expect(isVisitorUuid(VISITOR_UUID_HEX)).toBe(true)
    expect(isVisitorUuid('user@example.com')).toBe(false)
  })
})

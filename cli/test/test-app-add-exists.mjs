#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  isDuplicateAppCreateError,
  resolveAppAddDuplicateOutcome,
} from '../src/app/add.ts'

console.log('🧪 Testing app add duplicate handling...\n')

assert.equal(isDuplicateAppCreateError(new Error('app_id_already_exists | App ID already exists')), true)
assert.equal(isDuplicateAppCreateError(new Error('App ID already exists'), 409), true)
assert.equal(isDuplicateAppCreateError(new Error('HTTP 409'), 409), true)
assert.equal(isDuplicateAppCreateError(new Error('network unavailable')), false)
assert.equal(isDuplicateAppCreateError(new Error('insufficient permissions')), false)

const ownedOutcome = await resolveAppAddDuplicateOutcome(
  {
    apikey: 'test-key',
    appId: 'com.example.app',
    ownerOrg: 'org_123',
    createError: new Error('app_id_already_exists | App ID already exists'),
    httpStatus: 409,
  },
  {
    isAppInTargetOrganization: async () => true,
  },
)
assert.equal(ownedOutcome, 'duplicate_owned')

const takenOutcome = await resolveAppAddDuplicateOutcome(
  {
    apikey: 'test-key',
    appId: 'com.example.app',
    ownerOrg: 'org_123',
    createError: new Error('app_id_already_exists | App ID already exists'),
    httpStatus: 409,
  },
  {
    isAppInTargetOrganization: async () => false,
    isAppListedInOrganization: async () => false,
  },
)
assert.equal(takenOutcome, 'duplicate_taken')

const otherOrgReadableOutcome = await resolveAppAddDuplicateOutcome(
  {
    apikey: 'test-key',
    appId: 'com.example.app',
    ownerOrg: 'org_123',
    createError: new Error('app_id_already_exists | App ID already exists'),
    httpStatus: 409,
  },
  {
    isAppInTargetOrganization: async (_apikey, _appId, ownerOrg) => {
      assert.equal(ownerOrg, 'org_123')
      return false
    },
  },
)
assert.equal(otherOrgReadableOutcome, 'duplicate_taken')

const orgListOwnedOutcome = await resolveAppAddDuplicateOutcome(
  {
    apikey: 'test-key',
    appId: 'com.example.app',
    ownerOrg: 'org_123',
    createError: new Error('app_id_already_exists | App ID already exists'),
    httpStatus: 409,
  },
  {
    isAppInTargetOrganization: async () => null,
    isAppListedInOrganization: async () => true,
  },
)
assert.equal(orgListOwnedOutcome, 'duplicate_owned')

const otherErrorOutcome = await resolveAppAddDuplicateOutcome(
  {
    apikey: 'test-key',
    appId: 'com.example.app',
    ownerOrg: 'org_123',
    createError: new Error('Cannot create app | validation failed'),
    httpStatus: 400,
  },
  {
    isAppInTargetOrganization: async () => {
      throw new Error('isAppInTargetOrganization should not run for non-duplicate errors')
    },
  },
)
assert.equal(otherErrorOutcome, 'not_duplicate')

await assert.rejects(
  () => resolveAppAddDuplicateOutcome(
    {
      apikey: 'test-key',
      appId: 'com.example.app',
      ownerOrg: 'org_123',
      createError: new Error('app_id_already_exists | App ID already exists'),
      httpStatus: 409,
    },
    {
      isAppInTargetOrganization: async () => {
        throw new Error('upstream unavailable')
      },
    },
  ),
  /upstream unavailable/,
)

await assert.rejects(
  () => resolveAppAddDuplicateOutcome(
    {
      apikey: 'test-key',
      appId: 'com.example.app',
      ownerOrg: 'org_123',
      createError: new Error('app_id_already_exists | App ID already exists'),
      httpStatus: 409,
    },
    {
      isAppInTargetOrganization: async () => null,
      isAppListedInOrganization: async () => null,
    },
  ),
  /Grant app.read or org.read/,
)

console.log('✅ app add duplicate handling tests passed')

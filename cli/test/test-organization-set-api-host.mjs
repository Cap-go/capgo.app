#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveConfiguredOrganizationUpdateApiHost, resolveOrganizationUpdateApiHost } from '../src/organization/set.ts'

assert.equal(
  await resolveOrganizationUpdateApiHost({
    supaHost: 'https://self-hosted.example.com///',
    supaAnon: 'anon-key',
  }, true),
  'https://self-hosted.example.com/functions/v1',
)

assert.equal(
  await resolveOrganizationUpdateApiHost({
    supaHost: 'https://example.com/custom/supabase/',
    supaAnon: 'anon-key',
  }, true),
  'https://example.com/custom/supabase/functions/v1',
)

await assert.rejects(
  () => resolveOrganizationUpdateApiHost({
    supaHost: 'https://example.com/supabase?env=dev',
    supaAnon: 'anon-key',
  }, true),
  /query parameters or fragments/,
)

assert.equal(
  resolveConfiguredOrganizationUpdateApiHost({
    hostApi: 'https://api.capgo.app',
    supaHost: 'https://configured.example.com/',
    supaKey: 'anon-key',
  }),
  'https://configured.example.com/functions/v1',
)

assert.equal(
  resolveConfiguredOrganizationUpdateApiHost({
    hostApi: 'https://configured-api.example.com/functions/v1',
    supaHost: 'https://configured.example.com/',
    supaKey: 'anon-key',
  }),
  'https://configured-api.example.com/functions/v1',
)

console.log('organization set API host tests passed')

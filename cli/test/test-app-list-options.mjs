#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { APP_LIST_ORG_FILTER_WARNING, getAppListPath } from '../src/app/list.ts'

assert.equal(getAppListPath(0), 'app?page=0')
assert.equal(
  getAppListPath(2, 'org id/with?reserved=characters'),
  'app?page=2&org_id=org+id%2Fwith%3Freserved%3Dcharacters',
)
assert.equal(
  APP_LIST_ORG_FILTER_WARNING,
  'You have passed "--filter-by-org-id". You might have access to more apps. Remove the filter to see all apps',
)

const help = spawnSync(process.execPath, ['dist/index.js', 'app', 'list', '--help'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})

assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /--filter-by-org-id <orgId>/)

console.log('✅ App list organization filter checks passed')

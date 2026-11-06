#!/usr/bin/env bun
import assert from 'node:assert/strict'
import * as todo from '../src/app/todo.ts'
import { getBuilderOnlySetup } from '../src/app/builder-checklist.ts'
import { appId, createDualTodoProgress } from './fixtures/dual-todo.mjs'

const progress = createDualTodoProgress()
const before = JSON.stringify(progress)
const builder = todo.getAppTodoSteps(progress, 'builder')
assert.equal(builder.path, 'builder', 'an explicit Builder list must read the Builder steps of a dual assignment')
assert.equal(builder.steps.length, 10)
assert.equal(builder.steps.find(step => step.id === 'builder.ios.start_setup').at, '2026-01-01T12:00:00Z')
assert.equal(builder.steps.find(step => step.id === 'builder.android.successful_cloud_build').status, 'warning')
assert.deepEqual(todo.getAvailableAppTodoLists(progress), ['ota', 'builder'])
assert.equal(getBuilderOnlySetup(progress.onboarding), null, 'displaying both lists must not relax Builder-only setup routing')

const builderText = todo.formatAppTodoList(appId, progress, { list: 'builder' })
assert.match(builderText, /Builder checklist/)
assert.match(builderText, /4\/10 completed/)
assert.match(builderText, /🍎 iOS \(selected\)/)
assert.match(builderText, /🤖 Android/)
assert.match(builderText, /Note: You chose guided setup for TestFlight\.\n        The CLI will help/)
assert.match(builderText, /Warning: Cloud build failed/)
assert.doesNotMatch(builderText, /Install Capgo Updater|Create a channel/)

const ota = todo.getAppTodoSteps(progress, 'ota')
assert.equal(ota.path, 'ota')
assert.equal(ota.steps.length, 7)
const otaText = todo.formatAppTodoList(appId, progress, { list: 'ota' })
assert.match(otaText, /OTA checklist/)
assert.match(otaText, /2\/7 completed/)
assert.match(otaText, /Install Capgo Updater/)
assert.doesNotMatch(otaText, /Prepare your signing keystore|guided setup for TestFlight/)
assert.equal(todo.getAppTodoSteps({ ...progress, hasChannel: false }, 'ota').steps.find(step => step.id === 'add_channel').status, 'pending')
assert.equal(JSON.stringify(progress), before, 'switching the displayed list never changes saved onboarding state')

assert.throws(() => todo.resolveAppTodoView(progress, { interactive: false }), /--list builder.*--list ota/)
for (const list of ['builder', 'ota']) {
  for (const interactive of [true, false])
    assert.deepEqual(todo.resolveAppTodoView(progress, { list, interactive }), { list, tabs: false }, 'explicit selection prints one list and exits even in a terminal')
}
assert.deepEqual(todo.resolveAppTodoView(progress, { interactive: true }), { list: 'ota', tabs: true })
progress.onboarding.setup.selected_path = 'builder'
assert.deepEqual(todo.resolveAppTodoView(progress, { interactive: true }), { list: 'builder', tabs: true })
delete progress.onboarding.setup.selected_path
assert.deepEqual(todo.resolveAppTodoView(progress, { interactive: true }), { list: 'ota', tabs: true })
assert.throws(() => todo.resolveAppTodoView(progress, { list: 'all', interactive: false }), /builder.*ota/)

const builderOnly = createDualTodoProgress()
builderOnly.onboarding.setup.paths = ['builder']
builderOnly.onboarding.setup.selected_path = 'builder'
delete builderOnly.onboarding.setup.ota_todo_list_version
delete builderOnly.onboarding.setup.steps.ota
assert.deepEqual(todo.getAvailableAppTodoLists(builderOnly), ['builder'])
assert.deepEqual(todo.resolveAppTodoView(builderOnly, { interactive: false }), { list: 'builder', tabs: false })
assert.throws(() => todo.resolveAppTodoView(builderOnly, { list: 'ota', interactive: false }), /OTA.*not available/)

const otaOnly = createDualTodoProgress()
otaOnly.onboarding.setup.paths = ['ota']
assert.deepEqual(todo.getAvailableAppTodoLists(otaOnly), ['ota'])
assert.deepEqual(todo.resolveAppTodoView(otaOnly, { interactive: false }), { list: 'ota', tabs: false })
assert.throws(() => todo.resolveAppTodoView(otaOnly, { list: 'builder', interactive: false }), /Builder.*not available/)
for (const patch of [{ builder_todo_list_version: '2' }, { builder_todo_list_version: 1 }, { todo_list_version: '4' }]) {
  const unsupported = createDualTodoProgress()
  Object.assign(unsupported.onboarding.setup, patch)
  assert.deepEqual(todo.getAvailableAppTodoLists(unsupported), ['ota'], 'unsupported Builder versions do not create a second list')
}
for (const onboarding of [null, {}, { setup: { todo_list_version: 3, steps: {} } }])
  assert.deepEqual(todo.resolveAppTodoView({ onboarding }, { interactive: false }), { list: 'ota', tabs: false }, 'legacy OTA remains usable without a selector')

console.log('Dual todo list selection, independent progress, notes, warnings and single-list compatibility passed')

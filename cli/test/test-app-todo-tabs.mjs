#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { render } from 'ink'
import React from 'react'
import { AppTodoTabs } from '../src/app/todo-tabs.tsx'
import { formatAppTodoList, getAppTodoSteps } from '../src/app/todo.ts'
import { appId, createDualTodoProgress } from './fixtures/dual-todo.mjs'
import { frameToGrid } from './helpers/vt-grid.mjs'

const progress = createDualTodoProgress()
const before = JSON.stringify(progress)
const lists = ['ota', 'builder'].map((id) => {
  const { steps } = getAppTodoSteps(progress, id)
  return { id, completed: steps.filter(step => ['done', 'skipped'].includes(step.status)).length, total: steps.length, content: formatAppTodoList(appId, progress, { list: id, color: true }) }
})
const stdout = new EventEmitter()
stdout.columns = 80
stdout.rows = 20
stdout.isTTY = true
stdout.lastFrame = ''
stdout.write = frame => { stdout.lastFrame = frame; return true }
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.ref = () => {}
stdin.unref = () => {}
let closed
const instance = render(React.createElement(AppTodoTabs, { lists, initialList: 'ota', color: true, onClose: list => closed = list }), {
  stdout, stderr: stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false,
})
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, 50))
}
const frame = () => stripVTControlCharacters(stdout.lastFrame)
const key = async input => { stdin.write(input); await settle() }
const assertFits = async () => {
  const text = stdout.lastFrame.replace(/\n$/, '')
  assert.ok(text.split('\n').length <= stdout.rows, `frame overflows ${stdout.columns}x${stdout.rows}:\n${frame()}`)
  const grid = await frameToGrid(text, { cols: stdout.columns, rows: stdout.rows })
  assert.match(grid.join('\n'), /q\/Esc: close/, 'exit controls remain visible')
}

try {
  await settle()
  assert.match(frame(), /\[⚡ OTA 2\/7\]/)
  assert.match(frame(), /Install Capgo Updater/)
  assert.doesNotMatch(frame(), /signing keystore|guided setup for TestFlight/)
  await assertFits()

  await key('\u001B[C')
  assert.match(frame(), /\[🧱 Builder 4\/10\]/)
  assert.match(frame(), /🍎 iOS \(selected\)/)
  assert.match(frame(), /Note: You chose guided setup for TestFlight/)
  assert.doesNotMatch(frame(), /Install Capgo Updater/)
  let seen = frame()
  for (let i = 0; i < 12; i++) {
    await key('\u001B[6~')
    seen += frame()
    await assertFits()
  }
  assert.match(seen, /🤖 Android/)
  assert.match(seen, /Warning: Cloud build failed/)
  assert.match(frame(), /Run this command again to recheck progress/)
  await key('\u001B[5~')
  assert.doesNotMatch(frame(), /Run this command again to recheck progress/, 'page up moves away from the bottom')

  await key('\t')
  assert.match(frame(), /\[⚡ OTA 2\/7\]/)
  assert.match(frame(), /App: com.example.dual/, 'changing tabs resets the scroll position')
  await key('\u001B[Z')
  assert.match(frame(), /\[🧱 Builder 4\/10\]/, 'Shift+Tab navigates backwards')
  assert.equal(closed, undefined, 'navigation must keep the tabs open')

  for (const [columns, rows] of [[40, 8], [50, 12], [120, 40], [80, 20]]) {
    Object.assign(stdout, { columns, rows })
    stdout.emit('resize')
    await settle()
    await assertFits()
    assert.match(frame(), /Builder 4\/10/)
  }
  Object.assign(stdout, { columns: 30, rows: 6 })
  stdout.emit('resize')
  await settle()
  assert.match(frame(), /Resize to at least/)
  Object.assign(stdout, { columns: 80, rows: 20 })
  stdout.emit('resize')
  await settle()
  await assertFits()
  await key('q')
  await instance.waitUntilExit()
  assert.equal(closed, 'builder')
  assert.equal(JSON.stringify(progress), before, 'navigation never writes progress or setup preferences')
}
finally {
  instance.unmount()
  instance.cleanup()
  stdin.destroy()
}
console.log('Todo tabs: keyboard navigation, independent content, notes, warnings, scrolling, resizing and clean exit passed')

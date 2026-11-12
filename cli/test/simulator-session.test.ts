import { describe, expect, it } from 'bun:test'
import { simulatorApiRequest, simulatorCommandTextOutput, simulatorStartOptions, simulatorTextOutput } from '../src/simulator/session'

describe('simulator CLI requests', () => {
  it('starts, reads, and stops one session', () => {
    expect(simulatorApiRequest('https://api.capgo.app/', 'start', {
      appId: 'ee.forgr.capgo',
      platform: 'ios',
      name: 'Checkout',
    })).toEqual({
      method: 'POST',
      url: 'https://api.capgo.app/build/simulator',
      body: { app_id: 'ee.forgr.capgo', platform: 'ios', name: 'Checkout' },
    })
    expect(simulatorApiRequest('https://api.capgo.app', 'get', {
      appId: 'ee.forgr.capgo',
      id: 'session-1',
    }).url).toBe('https://api.capgo.app/build/simulator/session-1?app_id=ee.forgr.capgo')
    expect(simulatorApiRequest('https://api.capgo.app', 'stop', {
      appId: 'ee.forgr.capgo',
      id: 'session-1',
    })).toEqual({
      method: 'POST',
      url: 'https://api.capgo.app/build/simulator/session-1/stop',
      body: { app_id: 'ee.forgr.capgo' },
    })
    expect(simulatorApiRequest('https://api.capgo.app', 'command', {
      appId: 'ee.forgr.capgo',
      id: 'session-1',
      deviceCommand: 'tap',
      x: 0.5,
      y: 0.2,
    })).toEqual({
      method: 'POST',
      url: 'https://api.capgo.app/build/simulator/session-1/command',
      body: { app_id: 'ee.forgr.capgo', command: 'tap', x: 0.5, y: 0.2 },
    })
  })

  it('maps the Commander buildJob flag onto buildJobId', () => {
    expect(simulatorStartOptions({ buildJob: 'job-1' }).buildJobId).toBe('job-1')
    expect(simulatorStartOptions({ buildJobId: 'job-2', buildJob: 'job-1' }).buildJobId).toBe('job-2')
  })

  it('prints a command result and writes a screenshot path', () => {
    expect(simulatorCommandTextOutput({
      data: { id: 'session-1', command: 'snapshot', result: { nodes: 1 } },
    }).text).toBe('{\n  "nodes": 1\n}\n')
    expect(simulatorCommandTextOutput({
      data: { id: 'session-1', command: 'screenshot', image_base64: 'aW1n' },
    })).toEqual({
      text: 'simulator-session-1.jpg\n',
      screenshot: { name: 'simulator-session-1.jpg', base64: 'aW1n' },
    })
  })

  it('prints the session id before the URL', () => {
    expect(simulatorTextOutput({
      id: 'session-1',
      url: 'https://ios-emulator.capgo.app/s/session-1/',
    })).toBe('session-1\nhttps://ios-emulator.capgo.app/s/session-1/\n')
    expect(simulatorTextOutput({ status: 'stopped' })).toBe('stopped\n')
  })
})

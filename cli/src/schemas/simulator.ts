import { z } from 'zod'

const appId = z.string().min(1).describe('Capgo app id, e.g. com.example.app')
const sessionId = z.string().uuid().describe('Simulator session id returned by capgo_start_simulator')
const deviceCommand = z.enum(['devices', 'screenshot', 'snapshot', 'home', 'lock', 'tap', 'open']).describe('agent-device command.')

export const mcpStartSimulatorInputSchema = z.object({
  appId,
  platform: z.enum(['ios', 'android']).optional().describe('Simulator platform. Defaults to ios.'),
  name: z.string().min(1).max(255).optional().describe('Session name.'),
  build_job_id: z.string().min(1).optional().describe('Saved iOS build job to install into the new simulator.'),
})

export const mcpGetSimulatorInputSchema = z.object({
  appId,
  session_id: sessionId,
})

export const mcpStopSimulatorInputSchema = z.object({
  appId,
  session_id: sessionId,
})

export const mcpSimulatorCommandInputSchema = z.object({
  appId,
  session_id: sessionId,
  command: deviceCommand,
  x: z.number().min(0).max(2000).optional().describe('Tap x. 0 to 1 is a fraction of the screen. A number above 1 is a point.'),
  y: z.number().min(0).max(2000).optional().describe('Tap y. 0 to 1 is a fraction of the screen. A number above 1 is a point.'),
  bundle_id: z.string().min(1).max(200).optional().describe('Bundle id for open.'),
})

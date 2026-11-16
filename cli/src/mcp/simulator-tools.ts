import type { McpServer } from '@modelcontextprotocol/server'
import {
  mcpGetSimulatorInputSchema,
  mcpSimulatorCommandInputSchema,
  mcpStartSimulatorInputSchema,
  mcpStopSimulatorInputSchema,
} from '../schemas/simulator'
import { executeSimulator, simulatorMcpContent } from '../simulator/session'

function failed(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Simulator request failed.' }],
    isError: true as const,
  }
}

export function registerSimulatorTools(server: McpServer) {
  server.registerTool(
    'capgo_start_simulator',
    {
      description: 'Start an iOS or Android cloud simulator. It uses one builder slot and build minutes. The result includes the session id, viewer URL, and remoteConfig in the Expo device-run shape (agentDeviceRemoteSessionUrl and token, webPreviewUrl and token, previewApiUrl). Drive it with capgo_simulator_command. Pass build_job_id to install a saved iOS build.',
      inputSchema: mcpStartSimulatorInputSchema,
    },
    async ({ appId: id, platform, name, build_job_id }) => {
      try {
        const payload = await executeSimulator('start', id, undefined, { platform, name, buildJobId: build_job_id })
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }
      catch (error) {
        return failed(error)
      }
    },
  )

  server.registerTool(
    'capgo_get_simulator',
    {
      description: 'Read one simulator session. A running session includes Expo remoteConfig so a client can connect to the agent-device endpoints.',
      inputSchema: mcpGetSimulatorInputSchema,
    },
    async ({ appId: id, session_id }) => {
      try {
        const payload = await executeSimulator('get', id, session_id, {})
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }
      catch (error) {
        return failed(error)
      }
    },
  )

  server.registerTool(
    'capgo_stop_simulator',
    {
      description: 'Stop a simulator session and record its build minutes.',
      inputSchema: mcpStopSimulatorInputSchema,
    },
    async ({ appId: id, session_id }) => {
      try {
        const payload = await executeSimulator('stop', id, session_id, {})
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
      }
      catch (error) {
        return failed(error)
      }
    },
  )

  server.registerTool(
    'capgo_simulator_command',
    {
      description: 'Send one command to a running simulator over the same agent-device channel an Expo simulator session exposes. Commands: devices, screenshot, snapshot, home, lock, tap, open. tap uses x and y from 0 to 1, or points above 1. open uses bundle_id. screenshot returns the JPEG.',
      inputSchema: mcpSimulatorCommandInputSchema,
    },
    async ({ appId: id, session_id, command, x, y, bundle_id }) => {
      try {
        const payload = await executeSimulator('command', id, session_id, { deviceCommand: command, x, y, bundleId: bundle_id })
        return simulatorMcpContent(payload)
      }
      catch (error) {
        return failed(error)
      }
    },
  )
}

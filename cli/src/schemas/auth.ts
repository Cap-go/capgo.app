import { z } from 'zod'

// ============================================================================
// MCP Auth Tool Schemas (capgo_login / capgo_logout)
// ============================================================================

export const mcpLoginInputSchema = z.object({
  apikey: z.string().min(1).describe('A Capgo API key (generate one at https://console.capgo.app/connect).'),
  scope: z.enum(['global', 'local']).optional().describe('Where to save the key: "global" (~/.capgo, default, all projects) or "local" (./.capgo, this project only — requires a git repo).'),
})

export const mcpLogoutInputSchema = z.object({
  scope: z.enum(['global', 'local']).optional().describe('Which saved key to remove: "global" (~/.capgo, default) or "local" (./.capgo).'),
})

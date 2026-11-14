import { describe, expect, it } from 'vitest'
import { canonicalMcpResourceUrl, mcpResourceUrlsMatch } from '../supabase/functions/_backend/mcp/oauth_shared.ts'

describe('mcp resource URL canonicalization', () => {
  it.concurrent.each([
    ['https://mcp.capgo.app/', 'https://mcp.capgo.app/mcp'],
    ['https://mcp.capgo.app', 'https://mcp.capgo.app/mcp'],
    ['https://mcp.capgo.app/mcp', 'https://mcp.capgo.app/mcp'],
    ['https://mcp.capgo.app/mcp/', 'https://mcp.capgo.app/mcp'],
  ])('treats alias root and /mcp as one resource (%s)', (input, canonical) => {
    expect(canonicalMcpResourceUrl(input)).toBe(canonical)
  })

  it.concurrent('leaves api.capgo.app resource unchanged', () => {
    expect(canonicalMcpResourceUrl('https://api.capgo.app/mcp')).toBe('https://api.capgo.app/mcp')
  })

  it.concurrent('matches OAuth client root resource to authorize-time /mcp resource', () => {
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/', 'https://mcp.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app', 'https://mcp.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://api.capgo.app/mcp', 'https://api.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/', 'https://api.capgo.app/mcp')).toBe(false)
  })
})
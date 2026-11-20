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

  it.concurrent('preserves query on api resource canonicalization', () => {
    expect(canonicalMcpResourceUrl('https://api.capgo.app/mcp?scope=other')).toBe('https://api.capgo.app/mcp?scope=other')
  })

  it.concurrent('matches OAuth client root resource to authorize-time /mcp resource', () => {
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/', 'https://mcp.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app', 'https://mcp.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://api.capgo.app/mcp', 'https://api.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/', 'https://api.capgo.app/mcp')).toBe(true)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/mcp', 'https://api.usecapgo.com/mcp')).toBe(true)
  })

  it.concurrent('rejects fragment, query drift, and unrelated resources', () => {
    expect(mcpResourceUrlsMatch('https://api.capgo.app/mcp#frag', 'https://api.capgo.app/mcp')).toBe(false)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/#x', 'https://mcp.capgo.app/')).toBe(false)
    expect(mcpResourceUrlsMatch('https://api.capgo.app/mcp?scope=other', 'https://api.capgo.app/mcp')).toBe(false)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/', 'https://api.capgo.app/mcp?scope=other')).toBe(false)
    expect(mcpResourceUrlsMatch('https://mcp.capgo.app/', 'https://evil.example/mcp')).toBe(false)
  })
})
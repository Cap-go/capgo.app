import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCloudlog, mockGetEnv } = vi.hoisted(() => ({
  mockCloudlog: vi.fn(),
  mockGetEnv: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: mockCloudlog,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
}))

const { supabaseTusCreateHandler } = await import('../supabase/functions/_backend/files/supabaseTusProxy.ts')

function createContext({
  requestUrl = 'https://api.capgo.app/functions/v1/files/upload/attachments',
  headers = {},
}: {
  requestUrl?: string
  headers?: Record<string, string>
}) {
  const request = new Request(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/offset+octet-stream',
      'Tus-Resumable': '1.0.0',
      'Upload-Length': '4',
      ...headers,
    },
  })

  return {
    req: {
      raw: request,
      url: request.url,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    get: (name: string) => {
      if (name === 'requestId')
        return 'req-files-tus-location'
      if (name === 'fileId')
        return 'orgs/org-id/apps/app-id/upload.zip'
      return undefined
    },
  }
}

describe('files TUS upload location rewriting', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mockCloudlog.mockReset()
    mockGetEnv.mockReset()
    mockGetEnv.mockImplementation((_, key: string) => {
      if (key === 'SUPABASE_URL')
        return 'https://project.supabase.co'
      if (key === 'SUPABASE_SERVICE_ROLE_KEY')
        return 'service-role-key'
      if (key === 'PUBLIC_URL')
        return ''
      return ''
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('ignores spoofed forwarded hosts outside local development', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 201,
      headers: {
        Location: 'https://project.supabase.co/storage/v1/upload/resumable/upload-id',
      },
    })) as typeof fetch

    const response = await supabaseTusCreateHandler(createContext({
      headers: {
        'X-Forwarded-Host': 'attacker.example',
        'X-Forwarded-Proto': 'https',
      },
    }) as any)

    expect(response.status).toBe(201)
    expect(response.headers.get('Location')).toBe('https://api.capgo.app/functions/v1/files/upload/attachments/upload-id')
  })

  it('uses the configured public URL before request or forwarded hosts', async () => {
    mockGetEnv.mockImplementation((_, key: string) => {
      if (key === 'SUPABASE_URL')
        return 'https://project.supabase.co'
      if (key === 'SUPABASE_SERVICE_ROLE_KEY')
        return 'service-role-key'
      if (key === 'PUBLIC_URL')
        return 'https://uploads.capgo.app'
      return ''
    })
    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 201,
      headers: {
        Location: 'https://project.supabase.co/storage/v1/upload/resumable/upload-id',
      },
    })) as typeof fetch

    const response = await supabaseTusCreateHandler(createContext({
      headers: {
        'X-Forwarded-Host': 'attacker.example',
      },
    }) as any)

    expect(response.status).toBe(201)
    expect(response.headers.get('Location')).toBe('https://uploads.capgo.app/functions/v1/files/upload/attachments/upload-id')
  })

  it('keeps forwarded local Supabase hosts working in development', async () => {
    mockGetEnv.mockImplementation((_, key: string) => {
      if (key === 'SUPABASE_URL')
        return 'http://kong:8000'
      if (key === 'SUPABASE_SERVICE_ROLE_KEY')
        return 'service-role-key'
      return ''
    })
    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 201,
      headers: {
        Location: 'http://kong:8000/storage/v1/upload/resumable/upload-id',
      },
    })) as typeof fetch

    const response = await supabaseTusCreateHandler(createContext({
      requestUrl: 'http://supabase_edge_runtime_files:8081/files/upload/attachments',
      headers: {
        'Host': 'supabase_edge_runtime_files:8081',
        'X-Forwarded-Host': 'localhost',
        'X-Forwarded-Port': '54321',
        'X-Forwarded-Proto': 'http',
      },
    }) as any)

    expect(response.status).toBe(201)
    expect(response.headers.get('Location')).toBe('http://localhost:54321/functions/v1/files/upload/attachments/upload-id')
  })
})

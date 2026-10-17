import type { McpToolInfo } from '../src/services/assistantAgent.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {} }))
vi.mock('~/services/console', () => ({ defaultApiHost: 'https://api.capgo.test' }))

const { tokenizeAssistantText } = await import('../src/utils/assistantText.ts')
const { parseChatGptCallback } = await import('../src/utils/chatgptCallback.ts')
const { needsConfirmation, parseResponseStream, responsesTools, runAssistant, sanitizeConsolePath } = await import('../src/services/assistantAgent.ts')
const chatgpt = await import('../src/services/chatgptAuth.ts')

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
}

const MCP_TOOLS: McpToolInfo[] = [
  { name: 'capgo_list_apps', title: 'List apps', description: 'List apps.', inputSchema: { type: 'object' }, annotations: { destructiveHint: false } },
  { name: 'capgo_delete_channel', title: 'Delete channel', description: 'Delete a channel. Devices fall back.', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
]

function sse(events: unknown[]): string {
  return events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

let callCounter = 0
function completed(output: { text?: string, calls?: Array<[string, Record<string, unknown>]> }) {
  const items: unknown[] = []
  if (output.text)
    items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output.text }] })
  for (const [name, args] of output.calls ?? [])
    items.push({ type: 'function_call', call_id: `call_${++callCounter}`, name, namespace: name.startsWith('capgo_') ? 'capgo' : 'capgo_ui', arguments: JSON.stringify(args) })
  return sse([{ type: 'response.created' }, { type: 'response.completed', response: { output: items } }])
}

interface Recorded { url: string, auth: string | null, body: any }

/** Fake OpenAI (models + responses) and the hosted Capgo MCP endpoint. */
function mockNetwork(outputs: Array<{ text?: string, calls?: Array<[string, Record<string, unknown>]> } | string>, mcpResult: unknown = [{ app_id: 'com.example.app' }]) {
  const openai: Recorded[] = []
  const mcp: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization')
    if (url === 'https://api.openai.com/v1/models')
      return Response.json({ models: [{ slug: 'gpt-hidden', visibility: 'hide' }, { slug: 'gpt-plan-default', visibility: 'list' }] })
    if (url === 'https://api.capgo.test/mcp') {
      const body = JSON.parse(String(init.body))
      mcp.push({ url, auth, body })
      const result = body.method === 'tools/list' ? { tools: MCP_TOOLS } : { content: [{ type: 'text', text: JSON.stringify(mcpResult) }] }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    }
    openai.push({ url, auth, body: JSON.parse(String(init.body)) })
    const next = outputs.shift() ?? { text: 'done' }
    return new Response(typeof next === 'string' ? next : completed(next), { status: 200 })
  }))
  return { openai, mcp }
}

const base = { accessToken: 'chatgpt-token', context: { path: '/dashboard' } }

describe('assistant helpers', () => {
  it.concurrent('only accepts same-origin console paths', () => {
    expect(sanitizeConsolePath('/app/com.example.app/channels')).toBe('/app/com.example.app/channels')
    expect(sanitizeConsolePath('https://evil.example')).toBeNull()
    expect(sanitizeConsolePath('//evil.example')).toBeNull()
    expect(sanitizeConsolePath('/\\evil.example')).toBeNull()
    expect(sanitizeConsolePath(42)).toBeNull()
  })

  it.concurrent('asks for confirmation on destructive and outward-facing tools only', () => {
    expect(needsConfirmation(MCP_TOOLS[1])).toBe(true)
    expect(needsConfirmation({ ...MCP_TOOLS[0], annotations: { openWorldHint: true } })).toBe(true)
    expect(needsConfirmation(MCP_TOOLS[0])).toBe(false)
  })

  it.concurrent('groups tools in namespaces as ChatGPT plan usage requires', () => {
    const tools = responsesTools(MCP_TOOLS) as Array<{ type: string, name: string, tools: Array<{ name: string }> }>
    expect(tools.map(tool => [tool.type, tool.name])).toEqual([['namespace', 'capgo_ui'], ['namespace', 'capgo']])
    expect(tools[1].tools.map(tool => tool.name)).toEqual(['capgo_list_apps', 'capgo_delete_channel'])
  })

  it.concurrent('renders bold, code and lists as plain text tokens', () => {
    expect(tokenizeAssistantText('Live on **production**: `1.2.3`\n\n- one')).toEqual([
      { type: 'paragraph', spans: [{ text: 'Live on ', style: 'plain' }, { text: 'production', style: 'bold' }, { text: ': ', style: 'plain' }, { text: '1.2.3', style: 'code' }] },
      { type: 'list', items: [[{ text: 'one', style: 'plain' }]] },
    ])
  })

  it.concurrent('falls back to streamed items when response.completed has an empty output', () => {
    const item = { type: 'function_call', call_id: 'c1', name: 'show_link', namespace: 'capgo_ui', arguments: '{}' }
    expect(parseResponseStream(sse([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [] } }])).calls)
      .toEqual([{ type: 'function_call', call_id: 'c1', name: 'show_link', namespace: 'capgo_ui', arguments: '{}' }])
    expect(parseResponseStream(sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])).failedCode)
      .toBe('subscription_sharing_usage_limit_exceeded')
    expect(parseResponseStream(sse([{ type: 'response.output_text.delta', delta: 'hi' }])).failedCode).toBe('stream_interrupted')
  })
})

describe('sign in with ChatGPT (in the browser, like the Capgo browser app)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers a dynamic agent client with PKCE and the plan usage scope', async () => {
    const url = new URL(await chatgpt.beginChatGptSignIn('user-1'))
    const params = Object.fromEntries(url.searchParams)
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(params).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Capgo',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    })
    expect(params.ext_agent_host_id).toMatch(/^urn:uuid:/)
    // The host id is stable for this user on this device.
    const again = new URL(await chatgpt.beginChatGptSignIn('user-1'))
    expect(again.searchParams.get('ext_agent_host_id')).toBe(params.ext_agent_host_id)
  })

  it('exchanges the code in the browser and keeps the tokens on the device only', async () => {
    const url = new URL(await chatgpt.beginChatGptSignIn('user-1'))
    const state = url.searchParams.get('state')!
    const nonce = url.searchParams.get('nonce')!
    const idToken = `e30.${btoa(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_issued', sub: 's', nonce, email: 'customer-onboarding@example.com' })).replace(/=+$/, '')}.sig`
    const tokenCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (target: string, init: RequestInit) => {
      tokenCalls.push(`${target} ${String(init.body)}`)
      return Response.json({ access_token: 'at', refresh_token: 'rt', id_token: idToken, expires_in: 3600, scope: 'openid email offline_access chatgpt.tokens.use.direct' })
    }))

    const credentials = await chatgpt.completeChatGptSignIn('user-1', { code: 'code-1', state, clientId: 'oaiapp_issued' })
    expect(credentials).toMatchObject({ clientId: 'oaiapp_issued', email: 'customer-onboarding@example.com', accessToken: 'at', refreshToken: 'rt' })
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0]).toContain('https://auth.openai.com/api/accounts/oauth/token')
    expect(tokenCalls[0]).toContain('client_id=oaiapp_issued')
    expect(chatgpt.loadChatGptCredentials('user-1')?.accessToken).toBe('at')
    expect(chatgpt.loadChatGptCredentials('user-2')).toBeNull()
    // Later sign-ins reuse the issued client instead of registering again.
    expect(new URL(await chatgpt.beginChatGptSignIn('user-1')).searchParams.get('client_id')).toBe('oaiapp_issued')
  })

  it('rejects a wrong state or a registration without an issued client', async () => {
    const url = new URL(await chatgpt.beginChatGptSignIn('user-1'))
    await expect(chatgpt.completeChatGptSignIn('user-1', { code: 'c', state: 'other', clientId: 'oaiapp_x' })).rejects.toThrow('chatgpt_sign_in_expired')
    await expect(chatgpt.completeChatGptSignIn('user-1', { code: 'c', state: url.searchParams.get('state')! })).rejects.toThrow('chatgpt_invalid_client')
    expect(chatgpt.resolveIssuedClientId('oaiapp_saved', 'oaiapp_other')).toBeNull()
    expect(chatgpt.resolveIssuedClientId('oaiapp_saved', undefined)).toBe('oaiapp_saved')
  })

  it('refreshes an expired token and signs out on a terminal refresh error', async () => {
    localStorage.setItem('capgo-assistant-chatgpt:user-1', JSON.stringify({ clientId: 'oaiapp_1', email: '', accessToken: 'old', refreshToken: 'rt', expiresAt: 0, scopes: [] }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 })))
    expect(await chatgpt.getChatGptAccessToken('user-1')).toBe('new')
    expect(chatgpt.loadChatGptCredentials('user-1')?.refreshToken).toBe('rt2')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'refresh_token_reused' }, { status: 400 })))
    await expect(chatgpt.getChatGptAccessToken('user-1', true)).rejects.toThrow('chatgpt_reconnect_required')
    expect(chatgpt.loadChatGptCredentials('user-1')).toBeNull()
  })

  it('parses only the loopback callback address', () => {
    expect(parseChatGptCallback('http://127.0.0.1:1455/auth/callback?code=abc&state=xyz&client_id=oaiapp_1', chatgpt.CHATGPT_REDIRECT_URI))
      .toEqual({ code: 'abc', state: 'xyz', clientId: 'oaiapp_1', error: undefined })
    expect(parseChatGptCallback('https://evil.example/auth/callback?code=abc', chatgpt.CHATGPT_REDIRECT_URI)).toBeNull()
    expect(parseChatGptCallback('nope', chatgpt.CHATGPT_REDIRECT_URI)).toBeNull()
  })
})

describe('assistant loop in the browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls OpenAI with the ChatGPT token and the hosted MCP with the Capgo key', async () => {
    const { openai, mcp } = mockNetwork([
      { calls: [['capgo_list_apps', {}]] },
      { calls: [['show_link', { title: 'Channels', path: '/app/com.example.app/channels' }], ['show_link', { title: 'Bad', path: 'https://evil.example' }]] },
      { text: 'Your channels are here.' },
    ])
    const result = await runAssistant({ ...base, apikey: 'capgo-key-1', messages: [{ role: 'user', content: 'Where are my channels?' }] })

    expect(result.reply).toBe('Your channels are here.')
    expect(result.cards).toEqual([{ type: 'link', title: 'Channels', description: undefined, path: '/app/com.example.app/channels' }])
    expect(result.actions).toEqual([{ tool: 'capgo_list_apps', title: 'List apps', ok: true }])
    expect(openai.every(call => call.url === 'https://api.openai.com/v1/responses' && call.auth === 'Bearer chatgpt-token')).toBe(true)
    expect(openai.every(call => call.body.store === false && call.body.stream === true && call.body.model === 'gpt-plan-default')).toBe(true)
    expect(openai[1].body.input.map((item: any) => item.type ?? item.role)).toEqual(['user', 'function_call', 'function_call_output'])
    expect(mcp.map(call => [call.body.method, call.auth])).toEqual([['tools/list', 'Bearer capgo-key-1'], ['tools/call', 'Bearer capgo-key-1']])
  })

  it('turns ask_user into a question card and stops', async () => {
    const { openai } = mockNetwork([{ calls: [['ask_user', { question: 'Which app?', options: ['com.a', 'com.b'] }]] }, { text: 'Pick an app.' }])
    const result = await runAssistant({ ...base, apikey: 'capgo-key-2', messages: [{ role: 'user', content: 'Show devices' }] })
    expect(result.cards).toEqual([{ type: 'question', question: 'Which app?', options: ['com.a', 'com.b'], allowFreeText: false }])
    expect(result.reply).toBe('Pick an app.')
    expect(openai[1].body).toMatchObject({ tool_choice: 'none' })
  })

  it('never runs a destructive tool without confirmation, then runs it once confirmed', async () => {
    const first = mockNetwork([{ calls: [['capgo_delete_channel', { appId: 'com.example.app', channel: 'beta' }]] }, { text: 'Confirm to delete beta.' }])
    const pending = await runAssistant({ ...base, apikey: 'capgo-key-3', messages: [{ role: 'user', content: 'Delete beta' }] })
    expect(first.mcp.filter(call => call.body.method === 'tools/call')).toEqual([])
    expect(pending.cards).toMatchObject([{ type: 'confirm', tool: 'capgo_delete_channel' }])

    const second = mockNetwork([sse([{ type: 'response.failed', response: { error: { code: 'server_error' } } }])], { status: 'ok' })
    const done = await runAssistant({ ...base, apikey: 'capgo-key-3', messages: [{ role: 'user', content: 'Delete beta' }], confirm: { tool: 'capgo_delete_channel', arguments: { appId: 'com.example.app', channel: 'beta' } } })
    expect(second.mcp.filter(call => call.body.method === 'tools/call').map(call => call.body.params.name)).toEqual(['capgo_delete_channel'])
    // The summary failed, but the completed action is still reported.
    expect(done.actions).toEqual([{ tool: 'capgo_delete_channel', title: 'Delete channel', ok: true }])
    expect(done.reply).toContain('completed')
  })

  it('refuses to confirm a tool that does not need confirmation', async () => {
    mockNetwork([])
    await expect(runAssistant({ ...base, apikey: 'capgo-key-4', messages: [{ role: 'user', content: 'hi' }], confirm: { tool: 'capgo_list_apps', arguments: {} } })).rejects.toThrow('invalid_confirm')
  })

  it('reports the ChatGPT plan usage limit', async () => {
    mockNetwork([sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])])
    await expect(runAssistant({ ...base, apikey: 'capgo-key-5', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'chatgpt_usage_limit' })
  })
})

import type { AssistantAction, AssistantCard, AssistantContext, AssistantResponse, AssistantTurn } from '~/services/assistant'
import { assistantRequest } from '~/services/assistantHttp'
import { defaultApiHost } from '~/services/console'

/**
 * The console assistant runs in the browser: the model is called with the user's own ChatGPT token
 * (OpenAI Responses API) and tools go straight to the hosted Capgo MCP server with the user's
 * assistant API key. Nothing about the conversation or the ChatGPT account goes through Capgo
 * servers except the MCP tool calls themselves, which use the normal public API rules (RBAC, rate limits).
 */

export const OPENAI_API_URL = 'https://api.openai.com/v1'
/** Preferred model; ChatGPT plans list their own catalog, so the first listed model is the fallback. */
export const PREFERRED_MODEL = 'gpt-6.1-sol'
const MAX_ROUNDS = 8
const MAX_TOOL_RESULT_CHARS = 20_000
const MODEL_TIMEOUT_MS = 90_000
const MCP_TIMEOUT_MS = 60_000

export class AssistantUpstreamError extends Error {
  constructor(readonly code: 'chatgpt_usage_limit' | 'chatgpt_not_eligible' | 'chatgpt_reconnect_required' | 'assistant_upstream_error' | 'assistant_key_invalid') {
    super(code)
  }
}

export interface McpToolInfo {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { title?: string, destructiveHint?: boolean, openWorldHint?: boolean }
}

// ---------------------------------------------------------------------------
// Capgo MCP (JSON-RPC over the hosted /mcp endpoint, stateless)
// ---------------------------------------------------------------------------

let rpcId = 0
const toolsCache = new Map<string, McpToolInfo[]>()

async function mcpRpc(apikey: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await assistantRequest(`${defaultApiHost}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${apikey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    timeoutMs: MCP_TIMEOUT_MS,
  })
  if (response.status === 401)
    throw new AssistantUpstreamError('assistant_key_invalid')
  const body = JSON.parse(response.text) as { result?: unknown, error?: { message?: string } }
  if (body.error)
    throw new Error(body.error.message ?? 'mcp_error')
  return body.result
}

export async function listMcpTools(apikey: string): Promise<McpToolInfo[]> {
  const cached = toolsCache.get(apikey)
  if (cached)
    return cached
  const result = await mcpRpc(apikey, 'tools/list', {}) as { tools?: McpToolInfo[] }
  const tools = result.tools ?? []
  toolsCache.set(apikey, tools)
  return tools
}

async function callMcpTool(apikey: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean, text: string }> {
  try {
    const result = await mcpRpc(apikey, 'tools/call', { name, arguments: args }) as { content?: Array<{ text?: string }>, isError?: boolean }
    return { ok: !result.isError, text: (result.content ?? []).map(part => part.text ?? '').join('\n') }
  }
  catch (error) {
    if (error instanceof AssistantUpstreamError)
      throw error
    return { ok: false, text: `Tool failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Deletes, overwrites, cancellations and push sends wait for an explicit click in the UI. */
export function needsConfirmation(tool: McpToolInfo): boolean {
  return tool.annotations?.destructiveHint === true || tool.annotations?.openWorldHint === true
}

// ---------------------------------------------------------------------------
// Prompt and tools
// ---------------------------------------------------------------------------

// Console routes the model may link to. Ids in braces must come from MCP tool results.
const CONSOLE_ROUTES = `
/dashboard - organization overview (usage, apps, charts)
/apps - list of apps in the current organization
/app/new - add a new app
/app/{appId} - app overview dashboard
/app/{appId}/getting-started - app onboarding steps
/app/{appId}/bundles - bundle list; /app/{appId}/bundles/new - upload a bundle
/app/{appId}/bundle/{bundleId} - one bundle (bundleId is the numeric id, not the version name); suffixes /history, /manifest, /dependencies, /preview
/app/{appId}/channels - channel list
/app/{appId}/channel/{channelId} - one channel (numeric id); suffixes /devices, /history, /statistics, /preview
/app/{appId}/devices - device list; /app/{appId}/device/{deviceId} - one device; suffixes /logs, /deployments
/app/{appId}/builds - native builds
/app/{appId}/notifications - push notifications
/app/{appId}/observe/errors, /observe/logs, /observe/native, /observe/compatibility - Observe health data
/app/{appId}/settings - app settings; /settings/access - app access; /settings/usage - app usage
/settings/account - profile; /settings/account/change-password; /settings/account/notifications
/settings/organization - organization settings; suffixes /members, /groups, /security, /api-keys, /webhooks, /audit-logs, /usage, /plans, /credits, /notifications
`.trim()

const UI_FUNCTIONS = [
  {
    type: 'function',
    name: 'show_link',
    description: 'Show the user a clickable card that opens a page of the Capgo console. Use it whenever you mention where something lives, after finding a resource, or after an action so the user can check the result.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short card title, e.g. "Production channel"' },
        description: { type: 'string', description: 'One short line about what the page shows' },
        path: { type: 'string', description: 'Console path starting with /, built from the route list and real ids' },
      },
      required: ['title', 'path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'ask_user',
    description: 'Ask the user a question with clickable answers. Use it instead of a plain-text question whenever a choice is needed (which app, which channel, which bundle, yes/no). Fill options from real data you fetched. Stop and wait for the answer after calling it.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'Answers shown as buttons' },
        allow_free_text: { type: 'boolean', description: 'Also let the user type another answer' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
]

/** ChatGPT plan usage only accepts function tools grouped in namespaces. */
export function responsesTools(mcpTools: McpToolInfo[]): unknown[] {
  return [
    { type: 'namespace', name: 'capgo_ui', description: 'Show cards in the Capgo chat panel.', tools: UI_FUNCTIONS },
    {
      type: 'namespace',
      name: 'capgo',
      description: 'Capgo Cloud MCP tools acting on the user account.',
      tools: mcpTools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, strict: false, parameters: tool.inputSchema })),
    },
  ]
}

function instructions(context: AssistantContext): string {
  const where = [
    context.path ? `Current page: ${context.path}` : null,
    context.orgId ? `Current organization: ${context.orgName ?? ''} (${context.orgId})` : null,
    context.appId ? `Current app: ${context.appId}` : null,
  ].filter(Boolean).join('\n')
  return [
    'You are the Capgo assistant inside the Capgo web console. You help users find things and act on their Capgo account (Capacitor live updates: apps, bundles, channels, devices, stats, builds, webhooks, notifications).',
    'Rules:',
    '- Use the capgo tools to look up real data before answering. Never invent ids, versions or numbers. Start with capgo_list_apps when you need an app.',
    '- "This app", "here" and similar refer to the current page context below.',
    '- When the user asks where something is, or after you find or change a resource, call show_link with the matching console page.',
    '- When you need the user to pick something, call ask_user with options from real data instead of asking in plain text.',
    '- Delete, overwrite, cancel and push-notification tools are not run immediately: the user gets a confirm card. Tell them to confirm it.',
    '- Uploading bundle files and starting native builds need the Capgo CLI: give the command (bunx @capgo/cli@latest ...).',
    '- Reply in the user\'s language, short and plain (a few sentences, simple markdown lists at most).',
    '',
    `Console routes:\n${CONSOLE_ROUTES}`,
    where ? `\n${where}` : '',
  ].join('\n')
}

/** Only same-origin console paths: no scheme, no protocol-relative or backslash tricks. */
export function sanitizeConsolePath(path: unknown): string | null {
  if (typeof path !== 'string')
    return null
  const trimmed = path.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\') || /\s/.test(trimmed) || trimmed.length > 500)
    return null
  return trimmed
}

function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

interface FunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  namespace?: string
}

type InputItem
  = | { role: 'user' | 'assistant' | 'developer', content: string }
    | FunctionCallItem
    | { type: 'function_call_output', call_id: string, output: string }

interface OutputItem {
  type: string
  content?: Array<{ type: string, text?: string }>
  call_id?: string
  name?: string
  arguments?: string
  namespace?: string
}

export interface ModelTurn {
  text: string
  calls: FunctionCallItem[]
  failedCode?: string
}

/**
 * Parse a Responses API event stream. With store: false the completed event can carry an empty
 * output, so items announced by response.output_item.done are kept as the fallback.
 */
export function parseResponseStream(text: string): ModelTurn {
  let completed = false
  let output: OutputItem[] = []
  const streamedItems: OutputItem[] = []
  let streamedText = ''
  let failedCode: string | undefined
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]')
      continue
    let event: { type?: string, delta?: string, item?: OutputItem, response?: { output?: OutputItem[], error?: { code?: string } }, error?: { code?: string }, code?: string }
    try {
      event = JSON.parse(data)
    }
    catch {
      continue
    }
    if (event.type === 'response.output_text.delta') {
      streamedText += event.delta ?? ''
    }
    else if (event.type === 'response.output_item.done' && event.item) {
      streamedItems.push(event.item)
    }
    else if (event.type === 'response.completed') {
      completed = true
      output = event.response?.output ?? []
    }
    else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      failedCode = event.response?.error?.code ?? event.type
    }
    else if (event.type === 'error') {
      failedCode = event.error?.code ?? event.code ?? 'error'
    }
  }
  if (!completed)
    return { text: '', calls: [], failedCode: failedCode ?? 'stream_interrupted' }
  const items = output.length ? output : streamedItems
  const itemText = items.filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('')
  const calls = items.filter(item => item.type === 'function_call' && item.call_id && item.name).map(item => ({
    type: 'function_call' as const,
    call_id: item.call_id!,
    name: item.name!,
    arguments: item.arguments ?? '{}',
    ...(item.namespace ? { namespace: item.namespace } : {}),
  }))
  return { text: itemText || streamedText, calls }
}

/** Map an OpenAI error code to an assistant state the chat knows how to show. */
export function upstreamError(code: string | undefined, status: number): AssistantUpstreamError {
  if (code === 'subscription_sharing_usage_limit_exceeded')
    return new AssistantUpstreamError('chatgpt_usage_limit')
  if (code === 'subscription_sharing_user_not_eligible')
    return new AssistantUpstreamError('chatgpt_not_eligible')
  if (code === 'subscription_sharing_invalid_user' || status === 401)
    return new AssistantUpstreamError('chatgpt_reconnect_required')
  return new AssistantUpstreamError('assistant_upstream_error')
}

const modelCache = new Map<string, string>()

/** Pick a model from the signed-in account's catalog (ChatGPT plans differ). */
export async function resolveModel(accessToken: string): Promise<string> {
  const cached = modelCache.get(accessToken)
  if (cached)
    return cached
  let slug = PREFERRED_MODEL
  try {
    const response = await assistantRequest(`${OPENAI_API_URL}/models`, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` }, timeoutMs: 10_000 })
    if (response.status === 200) {
      const body = JSON.parse(response.text) as { models?: Array<{ slug?: string, visibility?: string }> }
      const listed = (body.models ?? []).filter(model => model.slug && model.visibility === 'list').map(model => model.slug!)
      slug = listed.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : (listed[0] ?? PREFERRED_MODEL)
    }
  }
  catch {}
  modelCache.set(accessToken, slug)
  return slug
}

async function callModel(accessToken: string, prompt: string, input: InputItem[], tools: unknown[], allowTools: boolean): Promise<ModelTurn> {
  const model = await resolveModel(accessToken)
  let response
  try {
    response = await assistantRequest(`${OPENAI_API_URL}/responses`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${accessToken}`, 'content-type': 'application/json', 'accept': 'text/event-stream' },
      // ChatGPT plan usage requires store: false and stream: true. Tools stay declared on the last
      // turn (history references them); tool_choice none forces a plain answer.
      body: JSON.stringify({ model, instructions: prompt, input, tools, store: false, stream: true, ...(allowTools ? {} : { tool_choice: 'none' }) }),
      timeoutMs: MODEL_TIMEOUT_MS,
    })
  }
  catch {
    throw new AssistantUpstreamError('assistant_upstream_error')
  }
  if (response.status < 200 || response.status >= 300) {
    let code: string | undefined
    try {
      code = (JSON.parse(response.text) as { error?: { code?: string } }).error?.code
    }
    catch {}
    throw upstreamError(code, response.status)
  }
  const turn = parseResponseStream(response.text)
  if (turn.failedCode)
    throw upstreamError(turn.failedCode, 200)
  return turn
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export interface RunAssistantOptions {
  accessToken: string
  apikey: string
  messages: AssistantTurn[]
  context: AssistantContext
  confirm?: { tool: string, arguments: Record<string, unknown> }
}

export async function runAssistant(options: RunAssistantOptions): Promise<AssistantResponse> {
  const cards: AssistantCard[] = []
  const actions: AssistantAction[] = []
  const mcpTools = await listMcpTools(options.apikey)
  const toolsByName = new Map(mcpTools.map(tool => [tool.name, tool]))
  const tools = responsesTools(mcpTools)
  const prompt = instructions(options.context)
  const input: InputItem[] = options.messages.filter(turn => turn.content.trim()).slice(-40).map(turn => ({ role: turn.role, content: turn.content }))

  if (options.confirm) {
    const tool = toolsByName.get(options.confirm.tool)
    if (!tool || !needsConfirmation(tool))
      throw new Error('invalid_confirm')
    const result = await callMcpTool(options.apikey, tool.name, options.confirm.arguments)
    actions.push({ tool: tool.name, title: tool.title ?? tool.annotations?.title ?? tool.name, ok: result.ok })
    input.push({
      role: 'user',
      content: `I confirmed the action ${tool.name} with ${JSON.stringify(options.confirm.arguments)}. Result (${result.ok ? 'success' : 'error'}):\n${clip(result.text)}\nSummarize the outcome and link the affected page.`,
    })
  }

  // A confirmed action already ran: if the summary call fails, still report it instead of an error.
  let confirmedActionNeedsFallback = !!options.confirm && actions.at(-1)?.ok === true
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let turn: ModelTurn
    try {
      turn = await callModel(options.accessToken, prompt, input, tools, true)
    }
    catch (error) {
      if (confirmedActionNeedsFallback)
        return { reply: 'Done. The action completed, but I could not write a summary.', cards, actions }
      throw error
    }
    confirmedActionNeedsFallback = false
    if (!turn.calls.length)
      return { reply: turn.text, cards, actions }

    // store: false, so the whole history (including our function calls) is resent each round.
    if (turn.text)
      input.push({ role: 'assistant', content: turn.text })
    let waitForUser = false
    for (const call of turn.calls) {
      input.push(call)
      const args = parseArguments(call.arguments)
      let output: string
      if (call.name === 'show_link') {
        const path = sanitizeConsolePath(args.path)
        if (path) {
          cards.push({ type: 'link', title: String(args.title ?? path).slice(0, 120), description: typeof args.description === 'string' ? args.description.slice(0, 300) : undefined, path })
          output = 'Card shown to the user.'
        }
        else {
          output = 'Invalid path: use a console path starting with a single /.'
        }
      }
      else if (call.name === 'ask_user') {
        const options = Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === 'string' && option.trim() !== '').slice(0, 8).map(option => option.slice(0, 120)) : []
        cards.push({ type: 'question', question: String(args.question ?? '').slice(0, 500), options, allowFreeText: args.allow_free_text === true })
        waitForUser = true
        output = 'Question shown. Stop here and wait for the user to answer.'
      }
      else {
        const tool = toolsByName.get(call.name)
        if (!tool) {
          output = `Unknown tool: ${call.name}`
        }
        else if (needsConfirmation(tool)) {
          cards.push({ type: 'confirm', title: tool.title ?? tool.annotations?.title ?? tool.name, description: tool.description.split('. ')[0], tool: tool.name, arguments: args })
          waitForUser = true
          output = 'Not run yet: the user must click the confirm card. Tell them briefly what will happen.'
        }
        else {
          const result = await callMcpTool(options.apikey, tool.name, args)
          actions.push({ tool: tool.name, title: tool.title ?? tool.annotations?.title ?? tool.name, ok: result.ok })
          output = clip(result.text)
        }
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output })
    }

    if (waitForUser) {
      // Let the model add one short sentence, without more tool calls, then hand back to the user.
      input.push({ role: 'developer', content: 'Write one short sentence for the user now. Do not call tools.' })
      const final = await callModel(options.accessToken, prompt, input, tools, false).catch(() => ({ text: '' }))
      return { reply: final.text, cards, actions }
    }
  }
  return { reply: 'I stopped after too many steps. Try a narrower question.', cards, actions }
}

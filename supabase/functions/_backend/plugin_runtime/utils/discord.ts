import type {
  RESTPostAPIWebhookWithTokenJSONBody,
} from 'discord-api-types/v10'
import type { Context } from 'hono'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getEnv } from './utils.ts'

// Fields that should be completely removed from logs (never logged)
const REMOVED_FIELDS = ['password']
// Fields that should show first 4 and last 4 characters
const PARTIALLY_REDACTED_FIELDS = ['secret', 'token', 'apikey', 'api_key', 'authorization', 'credential', 'private_key']

// Partially redact a value - show first 4 and last 4 characters
function partialRedact(value: string): string {
  if (value.length <= 8) {
    return '***REDACTED***'
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

// Remove or redact sensitive fields from a string that might contain JSON
function sanitizeSensitiveFromString(str: string): string {
  let result = str

  // Completely remove password fields (including the key)
  for (const field of REMOVED_FIELDS) {
    // Remove "password":"value", or "password": "value" (with optional trailing comma)
    const jsonRegexWithComma = new RegExp(`"${field}"\\s*:\\s*"[^"]*"\\s*,?\\s*`, 'gi')
    result = result.replace(jsonRegexWithComma, '')
    // Clean up any resulting double commas or leading/trailing commas in objects
    result = result.replace(/,\s*,/g, ',')
    result = result.replace(/\{\s*,/g, '{')
    result = result.replace(/,\s*\}/g, '}')
  }

  // Partially redact other sensitive fields (show first 4 and last 4 chars)
  for (const field of PARTIALLY_REDACTED_FIELDS) {
    const jsonRegex = new RegExp(`("${field}"\\s*:\\s*)"([^"]*)"`, 'gi')
    result = result.replace(jsonRegex, (_match, prefix, value) => {
      return `${prefix}"${partialRedact(value)}"`
    })
  }

  return result
}

// Sanitize sensitive headers - remove or redact
function sanitizeSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase()
    // Skip password-related headers entirely
    if (REMOVED_FIELDS.some(field => lowerKey.includes(field))) {
      continue
    }
    else if (PARTIALLY_REDACTED_FIELDS.some(field => lowerKey.includes(field))) {
      sanitized[key] = partialRedact(value)
    }
    else {
      sanitized[key] = value
    }
  }
  return sanitized
}

export async function sendDiscordAlert(c: Context, payload: RESTPostAPIWebhookWithTokenJSONBody): Promise<boolean> {
  const webhookUrl = getEnv(c, 'DISCORD_ALERT')

  if (!webhookUrl) {
    cloudlog({ requestId: c.get('requestId'), message: 'Discord not set', payload: JSON.stringify(payload) })
    return true
  }

  try {
    const body = typeof payload === 'string'
      ? { content: payload }
      : payload

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      await response.text() // Consume body to prevent resource leak
      cloudlogErr({ requestId: c.get('requestId'), message: 'Discord webhook failed', status: response.status })
      return true
    }
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Discord webhook error', error })
    return true
  }
}

export function sendDiscordAlert500(c: Context, functionName: string, body: string, e: Error) {
  const requestId = c.get('requestId') ?? 'unknown'
  const timestamp = new Date().toISOString()
  const userAgent = c.req.header('user-agent') ?? 'unknown'
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
  const method = c.req.method
  const url = c.req.url
  const rawHeaders = Object.fromEntries((c.req.raw.headers as any).entries())
  const headers = sanitizeSensitiveHeaders(rawHeaders)
  const errorMessage = e?.message ?? 'Unknown error'
  const errorStack = e?.stack ?? 'No stack trace'
  const errorName = e?.name ?? 'Error'
  // Defense-in-depth: remove/sanitize sensitive fields from body string
  const safeBody = sanitizeSensitiveFromString(body)
  return sendDiscordAlert(c, {
    content: `🚨 **${functionName}** Error Alert`,
    embeds: [
      {
        title: `❌ ${functionName} Function Failed`,
        description: `**Error:** ${errorName}\n**Message:** ${errorMessage}`,
        color: 0xFF0000, // Red color
        timestamp,
        fields: [
          {
            name: '🔍 Request Details',
            value: `**Method:** ${method}\n**URL:** ${url}\n**Request ID:** ${requestId}`,
            inline: false,
          },
          {
            name: '🌐 Client Info',
            value: `**IP:** ${ip}\n**User-Agent:** ${userAgent}`,
            inline: false,
          },
          {
            name: '📝 Request Body',
            value: `\`\`\`\n${safeBody}\n\`\`\``,
            inline: false,
          },
          {
            name: '🔧 Headers',
            value: `\`\`\`json\n${JSON.stringify(headers, null, 2).substring(0, 1000)}\n\`\`\``,
            inline: false,
          },
          {
            name: '💥 Error Stack',
            value: `\`\`\`\n${errorStack.substring(0, 1000)}\n\`\`\``,
            inline: false,
          },
          {
            name: '🔍 Full Error Object',
            value: `\`\`\`json\n${JSON.stringify(e, Object.getOwnPropertyNames(e), 2).substring(0, 1000)}\n\`\`\``,
            inline: false,
          },
        ],
        footer: {
          text: `Function: ${functionName} | Environment: ${getEnv(c, 'ENVIRONMENT') || 'unknown'}`,
        },
      },
    ],
  }).catch((e: any) => {
    cloudlogErr({ requestId, functionName, message: 'sendDiscordAlert500 failed', error: e })
  })
}

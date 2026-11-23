import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export function mcpRequestIncludesInitialize(body: unknown): boolean {
  const arrayMessage = Array.isArray(body) ? body : [body]
  return arrayMessage.some(msg => InitializeRequestSchema.safeParse(msg).success)
}
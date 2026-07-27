/** Minimal MCP server surface used by Capgo tool registration helpers and tests. */
export interface McpRegistrar {
  registerTool: (name: string, config: { description: string, inputSchema?: unknown }, handler: (...args: any[]) => any) => unknown
  registerPrompt: (
    name: string,
    config: { description: string },
    handler: () => { messages: Array<{ role: 'user' | 'assistant', content: { type: 'text', text: string } }> },
  ) => unknown
}

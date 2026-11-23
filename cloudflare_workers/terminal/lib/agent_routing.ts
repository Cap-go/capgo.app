import { getAgentByName as agentsGetAgentByName } from 'agents'
import type { TerminalProps, TerminalSession } from '../terminal_session.ts'
import { TERMINAL_INTERNAL_MCP_BRIDGE } from './mcp_bridge.ts'
import { requestHasClientMcpHeaders } from './ws.ts'
import { terminalDurableObjectName, terminalMcpSessionHeaderId } from './security.ts'

type AgentRoutingOptions = Parameters<typeof agentsGetAgentByName>[2]

function stubWithMcpBridge(stub: DurableObjectStub) {
  const fetch = stub.fetch.bind(stub)
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === 'fetch') {
        return (request: Request, input?: RequestInit) => {
          if (requestHasClientMcpHeaders(request)) {
            const headers = new Headers(request.headers)
            headers.set(TERMINAL_INTERNAL_MCP_BRIDGE, '1')
            return fetch(new Request(request, { headers }), input)
          }
          return fetch(request, input)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export async function wrapMcpStreamableNamespace(
  namespace: DurableObjectNamespace<TerminalSession>,
  sessionKey: string,
): Promise<DurableObjectNamespace<TerminalSession>> {
  const headerId = await terminalMcpSessionHeaderId(sessionKey)
  return new Proxy(namespace, {
    get(target, prop, receiver) {
      if (prop === 'newUniqueId') {
        return () => ({
          toString: () => headerId,
          equals: (other: DurableObjectId) => other.toString() === headerId,
        }) as DurableObjectId
      }
      if (prop === 'get') {
        return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
          stubWithMcpBridge(target.get(id, options))
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as DurableObjectNamespace<TerminalSession>
}

export async function getAgentByName(
  namespace: DurableObjectNamespace,
  name: string,
  options?: AgentRoutingOptions,
) {
  const props = (options as { props?: TerminalProps } | undefined)?.props
  let agentName = name
  if (props?.sessionKey)
    agentName = await terminalDurableObjectName(props.sessionKey)

  const stub = await agentsGetAgentByName(
    namespace as Parameters<typeof agentsGetAgentByName>[0],
    agentName,
    options,
  )
  return stubWithMcpBridge(stub)
}
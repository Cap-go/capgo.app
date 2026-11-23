export function inactiveTerminalMcpResponse(): Response {
  return Response.json({ error: 'session_not_active' }, { status: 410 })
}
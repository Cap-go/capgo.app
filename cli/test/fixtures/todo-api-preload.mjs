import { createDualTodoProgress } from './dual-todo.mjs'

// Child-process tests use real Node streams with terminal capabilities, without
// requiring the optional node-pty native binary on each CI platform.
if (process.env.CAPGO_TODO_FIXTURE_TTY === '1') {
  Object.assign(process.stdin, { isTTY: true, setRawMode(value) { this.isRaw = value; return this } })
  Object.assign(process.stdout, { isTTY: true, columns: 80, rows: 24 })
}

// Only used by the local demo and built-command tests. No request reaches an API.
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input?.url ?? String(input)
  if (!url.startsWith('http'))
    return nativeFetch(input, init)
  const scenario = process.env.CAPGO_TODO_FIXTURE_SCENARIO
  if (url.includes('/private/cli/preflight')) {
    if (scenario === 'two-factor')
      return Response.json({ error: '2fa_required', message: 'Two-factor authentication is required by this organization' }, { status: 403 })
    return Response.json({ user_id: 'todo-user', org_id: 'todo-org', warnings: [] })
  }
  if (url.includes('/private/onboarding_progress')) {
    if (scenario === 'denied')
      return Response.json({ error: 'app_access_denied' }, { status: 403 })
    const progress = createDualTodoProgress()
    const setup = progress.onboarding.setup
    if (scenario === 'builder-only') {
      setup.paths = ['builder']
      setup.selected_path = 'builder'
      delete setup.ota_todo_list_version
      delete setup.steps.ota
    }
    if (scenario === 'ota-only')
      setup.paths = ['ota']
    if (scenario === 'partial')
      progress.checkErrors = ['add_channel']
    // Like the backend, billing is only returned when the CLI asks for it.
    if (scenario === 'trial' && JSON.parse(init.body).includeBilling === true)
      progress.billing = { status: 'available', orgId: 'todo-org', trialEndsAt: '2099-01-01T12:00:00Z', isPaying: false, hasCredits: false }
    return Response.json(progress)
  }
  return Response.json({ status: 'ok' })
}

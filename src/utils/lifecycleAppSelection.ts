export function lifecycleAppSelection(app: { app_id: string, id: string | null, owner_org: string, onboarding: unknown }) {
  const onboarding = app.onboarding as { setup?: { todo_list_version?: number, selected_path?: string, paths?: string[] } } | null
  const setup = onboarding?.setup
  const path = setup?.selected_path ?? (setup?.paths?.length === 1 ? setup.paths[0] : null)
  if (!app.id || setup?.todo_list_version !== 4 || (path !== 'ota' && path !== 'builder'))
    return null
  return { event: 'Lifecycle App Selected', channel: 'app-onboarding', tracking_version: 2, org_id: app.owner_org, tags: { app_id: app.app_id, app_incarnation: app.id, product: path } }
}

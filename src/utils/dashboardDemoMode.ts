export function shouldShowDashboardDemoData(options: {
  forceDemo: boolean
  appId?: string | null
  appsCount: number
  appsLoaded: boolean
}) {
  if (options.forceDemo)
    return true
  // A concrete app page always has real data (or an empty real chart).
  // Never overlay "sample data" just because the org apps store is stale.
  if (options.appId)
    return false
  if (options.appsCount > 0)
    return false
  return options.appsLoaded
}

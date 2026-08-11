// register vue composition api globally
import type { RouteLocationNormalized, Router } from 'vue-router'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { setupLayouts } from 'virtual:generated-layouts'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import { installDeepLinkHandler } from '~/services/deepLinks'
import { getNativeExternalPurchaseRedirect, isNativeAppStoreContext, isNativeExternalPurchaseRestrictedPath } from '~/services/nativeCompliance'
import { posthogLoader } from '~/services/posthog'
import { getErrorMessage, isComponentResolutionErrorMessage, isKnownCrawlerNoiseErrorMessage, isStaleAssetErrorMessage } from '~/services/staleAssetErrors'
import { getLocalConfig } from '~/services/supabase'
import App from './App.vue'
import { getRemoteConfig } from './services/supabase'
// your custom styles here
import './styles/style.css'

// Handle chunk load errors (stale chunks after deployment)
// When a new version is deployed, old chunk URLs return 404/HTML instead of JS
const CHUNK_RELOAD_TIMESTAMP_KEY = 'capgo_chunk_reload_timestamp'
const CHUNK_RELOAD_TOAST_KEY = 'capgo_chunk_reload_toast'
const CHUNK_RELOAD_COOLDOWN_MS = 30_000

function getChunkReloadTimestamp(): number | null {
  try {
    const storedValue = sessionStorage.getItem(CHUNK_RELOAD_TIMESTAMP_KEY)
    if (!storedValue)
      return null

    const timestamp = Number.parseInt(storedValue, 10)
    return Number.isFinite(timestamp) ? timestamp : null
  }
  catch {
    return null
  }
}

function setChunkReloadTimestamp(): void {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_TIMESTAMP_KEY, String(Date.now()))
  }
  catch {
    // Ignore storage access failures and still let the reload happen.
  }
}

function hasChunkReloadToastPending(): boolean {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_TOAST_KEY) === 'true'
  }
  catch {
    return false
  }
}

function setChunkReloadToastPending(): void {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_TOAST_KEY, 'true')
  }
  catch {
    // Ignore storage access failures and still let the reload happen.
  }
}

function clearChunkReloadToastPending(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_TOAST_KEY)
  }
  catch {
    // Ignore storage access failures during cleanup.
  }
}

// `targetPath` is the route the user was navigating to when the chunk failed.
// A bare reload restores the URL the browser is still on (the page the user is
// leaving), so it silently throws the navigation away. When we know the target
// we navigate there instead, so the user lands where they asked to go.
function handleChunkError(message: string, targetPath?: string) {
  const previousReload = getChunkReloadTimestamp()
  if (previousReload && Date.now() - previousReload < CHUNK_RELOAD_COOLDOWN_MS) {
    console.warn('Chunk load error detected again after a recent reload, skipping automatic reload.', message)
    return
  }

  console.warn('Chunk load error detected, reloading page...', message)
  setChunkReloadTimestamp()
  setChunkReloadToastPending()
  if (targetPath)
    window.location.assign(targetPath)
  else
    window.location.reload()
}

window.addEventListener('error', (event) => {
  if (isStaleAssetErrorMessage(event.message)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    handleChunkError(event.message)
    return
  }

  if (isKnownCrawlerNoiseErrorMessage(event.message)) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)

// Also handle unhandled promise rejections for dynamic imports
window.addEventListener('unhandledrejection', (event) => {
  const message = getErrorMessage(event.reason) ?? String(event.reason)
  if (isStaleAssetErrorMessage(message)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    handleChunkError(message)
    return
  }

  if (isKnownCrawlerNoiseErrorMessage(message)) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
})

window.addEventListener('vite:preloadError', (event) => {
  const preloadEvent = event as Event & { payload?: unknown, detail?: unknown }
  const message = getErrorMessage(preloadEvent.payload)
    ?? getErrorMessage(preloadEvent.detail)
    ?? 'Vite preload error'
  if (!isStaleAssetErrorMessage(message))
    return
  // Deliberately do NOT call event.preventDefault(): Vite's preload helper only
  // rethrows the underlying import failure when the default is not prevented.
  // Preventing it makes `__vitePreload` resolve with `undefined`, so a lazy route
  // resolves to a falsy component and vue-router throws "Couldn't resolve
  // component" instead of the real chunk error. Letting it rethrow keeps the
  // rejection matching STALE_ASSET_ERROR_PATTERNS, so it still gets the reload
  // (below) and the PostHog suppression this handler was written to provide.
  handleChunkError(message)
})

const guestPath = ['/login', '/delete_account', '/confirm-signup', '/forgot_password', '/resend_email', '/onboarding', '/register', '/invitation', '/email-preferences', '/scan', '/sso-callback']

function redirectAppPath(suffix: string) {
  return (to: RouteLocationNormalized) => ({
    path: `/app/${encodeURIComponent(String((to.params as { app: string }).app))}${suffix}`,
    query: to.query,
    hash: to.hash,
  })
}

function isGuestRoutePath(path: string) {
  return guestPath.includes(path) || path === '/preview' || path.startsWith('/preview/')
}

getRemoteConfig()
const app = createApp(App)
CapacitorUpdater.notifyAppReady()
console.log(`Capgo Version : "${import.meta.env.VITE_APP_VERSION}"`)
// setup up pages with layouts
const newRoutes = routes.map((route) => {
  if (isGuestRoutePath(route.path)) {
    route.meta ??= {}
    route.meta.layout = 'naked'
  }
  else {
    route.meta ??= {}
    route.meta.middleware = 'auth'
  }
  return route
})
const router = createRouter({
  routes: [
    { path: '/', redirect: '/login' },
    // Canonical apps list route
    { path: '/app', redirect: '/apps' },
    { path: '/settings/plans', redirect: '/settings/organization/plans' },
    { path: '/settings/usage', redirect: '/settings/organization/usage' },
    { path: '/settings/change-password', redirect: '/settings/account/change-password' },
    { path: '/settings/changepassword', redirect: '/settings/account/change-password' },
    { path: '/settings/notifications', redirect: '/settings/account/notifications' },
    { path: '/dashboard/settings/organization/plans', redirect: '/settings/organization/plans' },
    { path: '/dashboard/settings/organization/usage', redirect: '/settings/organization/usage' },
    { path: '/p/:package', redirect: to => `/app/${(to.params as { package: string }).package}` },
    {
      path: '/p/:package/logs',
      redirect: (to) => {
        const { tab: _, ...query } = to.query
        return {
          path: `/app/${encodeURIComponent(String((to.params as { package: string }).package))}/observe/logs`,
          query,
          hash: to.hash,
        }
      },
    },
    { path: '/dashboard/apikeys', redirect: '/apikeys' },
    { path: '/dashboard/settings/account', redirect: '/settings/account' },
    { path: '/dashboard/settings/change-password', redirect: '/settings/account/change-password' },
    { path: '/dashboard/settings/notifications', redirect: '/settings/notifications' },
    { path: '/dashboard/settings/organization/general', redirect: '/settings/organization/' },
    { path: '/dashboard/settings/organization/members', redirect: '/settings/organization/members' },
    { path: '/dashboard/settings/organization/plans', redirect: '/settings/organization/plans' },
    { path: '/dashboard/settings/organization/usage', redirect: '/settings/organization/usage' },
    { path: '/app/p/:package', redirect: to => `/app/${(to.params as { package: string }).package}` },
    { path: '/app/p/:package/bundles', redirect: to => `/app/${(to.params as { package: string }).package}` },
    { path: '/app/p/:package/channels', redirect: to => `/app/${(to.params as { package: string }).package}` },
    { path: '/app/p/:package/devices', redirect: to => `/app/${(to.params as { package: string }).package}` },
    {
      path: '/app/p/:package/logs',
      redirect: (to) => {
        const { tab: _, ...query } = to.query
        return {
          path: `/app/${encodeURIComponent(String((to.params as { package: string }).package))}/observe/logs`,
          query,
          hash: to.hash,
        }
      },
    },
    {
      path: '/app/package/:package',
      redirect: to => ({
        path: `/app/${encodeURIComponent(String((to.params as { package: string }).package))}`,
        query: to.query,
        hash: to.hash,
      }),
    },
    {
      path: '/app/package/:package/settings',
      redirect: to => ({
        path: `/app/${encodeURIComponent(String((to.params as { package: string }).package))}/settings`,
        query: to.query,
        hash: to.hash,
      }),
    },
    // Legacy app tab URLs after settings/observe revamp
    { path: '/app/:app/info', redirect: redirectAppPath('/settings') },
    { path: '/app/:app/access', redirect: redirectAppPath('/settings/access') },
    { path: '/app/:app/logs/insights', redirect: redirectAppPath('/observe/updater') },
    { path: '/app/:app/logs', redirect: redirectAppPath('/observe/logs') },
    { path: '/app/:app/compatibility', redirect: redirectAppPath('/observe/compatibility') },
    { path: '/app/:app/observe', redirect: redirectAppPath('/observe/native') },
    ...setupLayouts(newRoutes),
  ],
  history: createWebHistory(import.meta.env.BASE_URL),
})

// Recover from lazy-route load failures that slip past the vite:preloadError
// handler (e.g. a navigation that races the reload). vue-router surfaces these
// as "Couldn't resolve component" once a stale chunk fails to import, so treat
// them as chunk errors and trigger the same reload instead of leaving the user
// on a dead route.
router.onError((error, to) => {
  const message = getErrorMessage(error) ?? String(error)
  if (isStaleAssetErrorMessage(message) || isComponentResolutionErrorMessage(message))
    handleChunkError(message, to?.fullPath)
})

router.beforeEach((to, from, next) => {
  if (isNativeAppStoreContext() && isNativeExternalPurchaseRestrictedPath(to.path)) {
    return next(getNativeExternalPurchaseRedirect(to.path))
  }

  if (to.path.startsWith('/app/') && to.query.tab) {
    const tab = to.query.tab as string
    const newPath = to.path.endsWith('/') ? `${to.path}${tab}` : `${to.path}/${tab}`
    const { tab: _, ...newQuery } = to.query
    return next({ path: newPath, query: newQuery, hash: to.hash })
  }
  next()
})

const config = getLocalConfig()
posthogLoader(config.supaHost)

// install all modules under `modules/`
type UserModule = (ctx: { app: typeof app, router: Router }) => void

Object.values(import.meta.glob<{ install: UserModule }>('./modules/*.ts', { eager: true }))
  .forEach(i => i.install?.({ app, router }))

app.use(router)
void installDeepLinkHandler(router)

router.isReady().then(async () => {
  app.mount('#app')

  // Wait for vue-sonner component to be mounted
  setTimeout(async () => {
    const key = hasChunkReloadToastPending()
    console.log('Checking for chunk reload toast...', key)
    // Show toast if we just reloaded due to chunk error
    if (key) {
      clearChunkReloadToastPending()
      const { toast } = await import('vue-sonner')
      toast.info('App updated! Page was refreshed to load the latest version.')
    }
  }, 500)
})

import type { Router } from 'vue-router'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { InstallReferrer } from '@capgo/capacitor-install-referrer'
import { parsePreviewDeepLink, previewLinkFromInstallReferrer } from '~/services/previewLinks'
import { routePreviewScan } from '~/services/previewNavigation'

const CONSUMED_DEFERRED_PREVIEW_STORAGE_KEY = 'capgo.consumed_deferred_preview'
const INSTALL_REFERRER_TIMEOUT_MS = 3000

async function routePreviewLink(router: Router, url: string) {
  try {
    await routePreviewScan(router, url)
    return true
  }
  catch (error) {
    console.warn('Failed to route preview deep link', error)
    return false
  }
}

async function routeWebLink(router: Router, url: URL) {
  try {
    await router.push(`${url.pathname}${url.search}${url.hash}`)
    return true
  }
  catch (error) {
    console.warn('Failed to route web deep link', error)
    return false
  }
}

function isCapgoConsoleHost(hostname: string) {
  return hostname === 'console.capgo.app' || /^console\.(?:dev|preprod|staging)\.capgo\.app$/.test(hostname)
}

function handleDeepLink(router: Router, rawUrl: string) {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  }
  catch {
    return false
  }

  if (parsePreviewDeepLink(rawUrl)) {
    void routePreviewLink(router, rawUrl)
    return true
  }

  if (url.protocol === 'https:' && isCapgoConsoleHost(url.hostname)) {
    void routeWebLink(router, url)
    return true
  }

  return false
}

function getConsumedDeferredPreviewLink() {
  try {
    return localStorage.getItem(CONSUMED_DEFERRED_PREVIEW_STORAGE_KEY)
  }
  catch {
    return null
  }
}

function setConsumedDeferredPreviewLink(previewUrl: string) {
  try {
    localStorage.setItem(CONSUMED_DEFERRED_PREVIEW_STORAGE_KEY, previewUrl)
  }
  catch {
    // Ignore storage failures; opening the preview matters more than deduping it.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<T | undefined>([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
  }
}

async function routeDeferredPreviewLink(router: Router) {
  if (Capacitor.getPlatform() !== 'android')
    return

  try {
    const result = await withTimeout(InstallReferrer.getReferrer(), INSTALL_REFERRER_TIMEOUT_MS)
    if (result?.platform !== 'android')
      return

    const previewUrl = previewLinkFromInstallReferrer(result.referrer)
    if (!previewUrl || getConsumedDeferredPreviewLink() === previewUrl)
      return

    const routed = await routePreviewLink(router, previewUrl)
    if (routed)
      setConsumedDeferredPreviewLink(previewUrl)
  }
  catch (error) {
    console.warn('Failed to route deferred preview link', error)
  }
}

// getLaunchUrl() returns the last opened URL for the whole app process, and a
// preview reloads the WebView into another bundle that runs this handler again.
// Without this guard a tapped preview link (already natively confirmed) restarts
// the preview on every reload, in a loop. sessionStorage is shared across bundle
// reloads (same origin and WebView) but cleared on a cold start, so opening the
// same link again later still works.
const HANDLED_LAUNCH_URL_KEY = 'capgo.handled_launch_url'

function readHandledLaunchUrl() {
  try {
    return sessionStorage.getItem(HANDLED_LAUNCH_URL_KEY)
  }
  catch {
    return null
  }
}

function markLaunchUrlHandled(url: string) {
  try {
    sessionStorage.setItem(HANDLED_LAUNCH_URL_KEY, url)
  }
  catch {
    // Storage unavailable: the link is still handled once for this page load.
  }
}

export async function installDeepLinkHandler(router: Router) {
  if (!Capacitor.isNativePlatform())
    return

  await CapacitorApp.addListener('appUrlOpen', (event) => {
    // A warm open also becomes the process launch URL replayed after reloads.
    markLaunchUrlHandled(event.url)
    handleDeepLink(router, event.url)
  })

  const launchUrl = (await CapacitorApp.getLaunchUrl())?.url
  if (launchUrl && readHandledLaunchUrl() === launchUrl)
    return
  if (launchUrl)
    markLaunchUrlHandled(launchUrl)
  const handledLaunchUrl = launchUrl ? handleDeepLink(router, launchUrl) : false
  if (!handledLaunchUrl)
    await routeDeferredPreviewLink(router)
}

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
    if (!result || result.platform !== 'android')
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

export async function installDeepLinkHandler(router: Router) {
  if (!Capacitor.isNativePlatform())
    return

  await CapacitorApp.addListener('appUrlOpen', (event) => {
    handleDeepLink(router, event.url)
  })

  const launchUrl = await CapacitorApp.getLaunchUrl()
  const handledLaunchUrl = launchUrl?.url ? handleDeepLink(router, launchUrl.url) : false
  if (!handledLaunchUrl)
    await routeDeferredPreviewLink(router)
}

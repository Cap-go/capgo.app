<script setup lang="ts">
import type { HttpResponse, PluginListenerHandle } from '@capacitor/core'
import type { BarcodeScanErrorEvent, BarcodeScannedEvent, BarcodeScannerOptions } from '@capgo/camera-preview'
import type { BundleInfo, DownloadEvent, DownloadOptions, StartPreviewSessionOptions } from '@capgo/capacitor-updater'
import type { PreviewDeepLink } from '~/services/previewLinks'
import { Clipboard } from '@capacitor/clipboard'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { CameraPreview } from '@capgo/camera-preview'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArrowLeft from '~icons/heroicons/arrow-left-20-solid'
import IconArrowPath from '~icons/heroicons/arrow-path-20-solid'
import IconArrowUturnLeft from '~icons/heroicons/arrow-uturn-left-20-solid'
import IconChevronDown from '~icons/heroicons/chevron-down-20-solid'
import IconClipboard from '~icons/heroicons/clipboard-document-20-solid'
import IconEllipsisHorizontal from '~icons/heroicons/ellipsis-horizontal-20-solid'
import IconLink from '~icons/heroicons/link-20-solid'
import IconPlay from '~icons/heroicons/play-20-solid'
import IconQrCode from '~icons/heroicons/qr-code-20-solid'
import IconRectangleStack from '~icons/heroicons/rectangle-stack-20-solid'
import IconTrash from '~icons/heroicons/trash-20-solid'
import { buildChannelPreviewLatestOptions, parsePreviewDeepLink } from '~/services/previewLinks'
import { useDisplayStore } from '~/stores/display'
import { buildChannelPreviewSubdomain, buildPreviewSubdomain, parsePreviewHostname } from '../../shared/preview-subdomain.ts'

const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()

const isNativePlatform = Capacitor.isNativePlatform()
const isScanning = ref(false)
const isLoading = ref(false)
const downloadProgress = ref(0)
const scannedUrl = ref('')
const errorMessage = ref('')
const manualUrl = ref('')
const statusMessage = ref('')
const scannerFrameRef = ref<HTMLElement | null>(null)
const debugMessages = ref<string[]>([])
const savedPreviews = ref<PreviewInfo[]>([])
const savedPreviewCurrent = ref<PreviewInfo | null>(null)
const savedPreviewLiveBundle = ref<BundleInfo | null>(null)
const previewManagerAvailable = ref(isNativePlatform)
const isLoadingPreviews = ref(false)
const previewActionId = ref('')
const previewActionName = ref('')
const showOptions = ref(false)
const pendingPreviewLoad = ref<PendingPreviewLoad | null>(null)

let downloadListener: Awaited<ReturnType<typeof CapacitorUpdater.addListener>> | null = null
let barcodeScannedListener: PluginListenerHandle | null = null
let barcodeScanErrorListener: PluginListenerHandle | null = null
let cameraPreviewStarted = false
let isHandlingBarcode = false
let barcodeWatchdogTimer: ReturnType<typeof setTimeout> | null = null

interface PreviewPayload {
  appId?: string
  version?: string
  url?: string
  checksum?: string | null
  sessionKey?: string | null
  manifest?: DownloadOptions['manifest']
}

interface PreviewHostTarget {
  appId: string
  channelId?: number
  payloadUrl: string
  rootUrl: string
  versionId?: number
}

interface PreviewPayloadFetchResult {
  payload: PreviewPayload
  sessionPayloadUrl?: string
}

interface PreviewSessionMetadata {
  appId?: string
  payloadUrl?: string
  name?: string
  source?: string
}

interface PreviewInfo {
  bundle?: BundleInfo | null
  id: string
  isActive?: boolean
  name?: string
  payloadUrl?: string
  source?: string
}

interface PreviewManagerUpdater {
  deletePreview?: (options: { id: string }) => Promise<{ deleted?: boolean }>
  listPreviews?: () => Promise<{ current?: PreviewInfo | null, liveBundle?: BundleInfo | null, previews: PreviewInfo[] }>
  resetPreview?: () => Promise<void>
  setPreview?: (options: { id: string }) => Promise<void>
  updatePreview?: (options: { id: string }) => Promise<{ preview: PreviewInfo, updated?: boolean }>
}

type PreviewStartOptions = StartPreviewSessionOptions & Pick<PreviewSessionMetadata, 'name' | 'source'>

const previewManagerUpdater = CapacitorUpdater as typeof CapacitorUpdater & PreviewManagerUpdater

type PreviewLoadSource = 'camera' | 'link'

interface PendingPreviewLoad {
  appLabel: string
  detail: string
  source: PreviewLoadSource
  start: () => Promise<void>
  url: string
}

interface HandleBarcodeScanOptions {
  nativeConfirmed?: boolean
}

const PREVIEW_PAYLOAD_PATH = '/.capgo/preview.json'

function formatDebugData(data: unknown) {
  try {
    if (data instanceof Error)
      return data.message || data.stack || String(data)

    const serialized = typeof data === 'string' ? data : JSON.stringify(data)
    return serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized
  }
  catch {
    return String(data)
  }
}

function debugLog(message: string, data?: unknown) {
  const line = data === undefined ? message : `${message}: ${formatDebugData(data)}`
  debugMessages.value = [`${new Date().toISOString().slice(11, 19)} ${line}`, ...debugMessages.value].slice(0, 80)

  if (data === undefined)
    console.log('[PreviewScan]', message)
  else
    console.log('[PreviewScan]', message, data)
}

function debugWarn(message: string, data?: unknown) {
  debugLog(message, data)

  if (data === undefined)
    console.warn('[PreviewScan]', message)
  else
    console.warn('[PreviewScan]', message, data)
}

async function copyDebugLogs() {
  if (!debugMessages.value.length)
    return

  const logs = debugMessages.value.slice().reverse().join('\n')
  try {
    await Clipboard.write({ string: logs })
    toast.success('Debug logs copied')
  }
  catch (error) {
    debugWarn('failed to copy debug logs with native clipboard', error)
    try {
      await navigator.clipboard.writeText(logs)
      toast.success('Debug logs copied')
    }
    catch (clipboardError) {
      debugWarn('failed to copy debug logs with browser clipboard', clipboardError)
      toast.error('Failed to copy debug logs')
    }
  }
}

function parseSafeUrl(value: string) {
  try {
    return new URL(value.trim())
  }
  catch {
    return null
  }
}

function isHttpUrl(value: string) {
  if (!value)
    return false

  const parsedUrl = parseSafeUrl(value)
  return parsedUrl?.protocol === 'https:' || parsedUrl?.protocol === 'http:'
}

function previewHostTargetFromUrl(value: string): PreviewHostTarget | null {
  const parsedUrl = parseSafeUrl(value)
  if (!parsedUrl || (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:'))
    return null

  const parsedHost = parsePreviewHostname(parsedUrl.hostname)
  if (!parsedHost)
    return null

  return {
    ...parsedHost,
    payloadUrl: new URL(PREVIEW_PAYLOAD_PATH, parsedUrl.origin).toString(),
    rootUrl: new URL('/', parsedUrl.origin).toString(),
  }
}

function previewPayloadUrlFromUrl(value: string) {
  return previewHostTargetFromUrl(value)?.payloadUrl ?? ''
}

function previewPayloadUrlFromChannelLink(previewLink: Extract<PreviewDeepLink, { type: 'channel' }>) {
  if (typeof previewLink.channelId !== 'number')
    return ''

  try {
    const subdomain = buildChannelPreviewSubdomain(previewLink.appId, previewLink.channelId)
    return `https://${subdomain}.preview.capgo.app${PREVIEW_PAYLOAD_PATH}`
  }
  catch {
    return ''
  }
}

function previewPayloadUrlFromBundleLink(previewLink: Extract<PreviewDeepLink, { type: 'bundle' }>) {
  if (!previewLink.appId || typeof previewLink.versionId !== 'number')
    return ''

  try {
    const subdomain = buildPreviewSubdomain(previewLink.appId, previewLink.versionId)
    return `https://${subdomain}.preview.capgo.app${PREVIEW_PAYLOAD_PATH}`
  }
  catch {
    return ''
  }
}

const progressPercentage = computed(() => Math.round(downloadProgress.value))
const trimmedManualUrl = computed(() => manualUrl.value.trim())
const manualPreviewLink = computed(() => parsePreviewDeepLink(trimmedManualUrl.value))
const normalizedManualUrl = computed(() => {
  const value = trimmedManualUrl.value
  if (!value)
    return ''

  if (manualPreviewLink.value)
    return value

  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
})
const manualPreviewPayloadUrl = computed(() => previewPayloadUrlFromUrl(normalizedManualUrl.value))
const canSubmitManualUrl = computed(() => !isLoading.value && (!!manualPreviewLink.value || !!manualPreviewPayloadUrl.value || isHttpUrl(normalizedManualUrl.value)))
const manualActionLabel = computed(() => {
  if (manualPreviewLink.value || manualPreviewPayloadUrl.value)
    return 'Start preview'
  return isNativePlatform ? 'Download update' : 'Open update URL'
})
const previewConfirmTitle = computed(() => pendingPreviewLoad.value?.source === 'camera' ? 'Load scanned preview?' : 'Load preview?')
const previewConfirmDescription = computed(() => pendingPreviewLoad.value?.source === 'camera'
  ? 'A QR code was scanned. Confirm before this preview is downloaded and applied.'
  : 'The app was opened from a preview link. Confirm before this preview is downloaded and applied.')
const scannerHint = computed(() => {
  if (isLoading.value)
    return 'Downloading preview…'
  if (statusMessage.value)
    return statusMessage.value
  if (isScanning.value)
    return 'Align the QR code within the frame'
  if (errorMessage.value)
    return 'Tap scan to try again or paste a link below'
  return isNativePlatform ? 'Tap scan to open the camera' : 'Paste a preview link to get started'
})
const downloadHost = computed(() => {
  if (!scannedUrl.value || !isHttpUrl(scannedUrl.value))
    return ''

  return new URL(scannedUrl.value).host
})
const hasSavedPreviewPanel = computed(() => isNativePlatform && previewManagerAvailable.value && (savedPreviews.value.length > 0 || isLoadingPreviews.value || !!savedPreviewCurrent.value))

function bundleVersion(bundle?: BundleInfo | null) {
  if (!bundle)
    return ''

  const bundleRecord = bundle as BundleInfo & { versionName?: string }
  return bundleRecord.version || bundleRecord.versionName || bundle.id
}

function previewLabel(preview: PreviewInfo) {
  return preview.name || bundleVersion(preview.bundle) || preview.id
}

function previewSourceLabel(preview: PreviewInfo) {
  if (preview.source === 'channel')
    return 'Channel'
  if (preview.source === 'bundle')
    return 'Bundle'
  if (preview.source === 'payload')
    return 'Preview'
  if (preview.source === 'url')
    return 'URL'
  return 'Preview'
}

function hostFromUrl(value?: string) {
  if (!value)
    return ''

  try {
    return new URL(value).host
  }
  catch {
    return ''
  }
}

function previewSubtitle(preview: PreviewInfo) {
  const details = [
    previewSourceLabel(preview),
    bundleVersion(preview.bundle),
    hostFromUrl(preview.payloadUrl),
  ].filter(Boolean)
  return details.join(' - ')
}

function previewNameFromUrl(value: string) {
  const parsedUrl = parseSafeUrl(value)
  return parsedUrl?.host || 'Preview'
}

function previewLinkAppLabel(previewLink: PreviewDeepLink) {
  return previewLink.appId || hostFromUrl(previewLink.payloadUrl) || 'Unknown app'
}

function previewLinkDetail(previewLink: PreviewDeepLink) {
  if (previewLink.type === 'channel') {
    if (previewLink.channelName)
      return `Channel ${previewLink.channelName}`
    if (typeof previewLink.channelId === 'number')
      return `Channel ${previewLink.channelId}`
    return 'Channel preview'
  }
  if (typeof previewLink.versionId === 'number')
    return `Bundle ${previewLink.versionId}`
  return 'Bundle preview'
}

function previewHostDetail(target: PreviewHostTarget | null) {
  if (!target)
    return 'Preview payload'
  if (typeof target.channelId === 'number')
    return `Channel ${target.channelId}`
  if (typeof target.versionId === 'number')
    return `Bundle ${target.versionId}`
  return 'Preview payload'
}

function queuePreviewLoad(previewLoad: PendingPreviewLoad) {
  debugLog('preview load confirmation requested', {
    appLabel: previewLoad.appLabel,
    detail: previewLoad.detail,
    source: previewLoad.source,
    url: previewLoad.url,
  })
  pendingPreviewLoad.value = previewLoad
  errorMessage.value = ''
  statusMessage.value = 'Preview detected. Confirm before loading it.'
  downloadProgress.value = 0
  showOptions.value = false
}

async function confirmPreviewLoad() {
  const previewLoad = pendingPreviewLoad.value
  if (!previewLoad)
    return

  pendingPreviewLoad.value = null
  statusMessage.value = ''
  debugLog('preview load confirmed', { source: previewLoad.source, url: previewLoad.url })
  try {
    await previewLoad.start()
  }
  catch (error) {
    debugWarn('failed to start confirmed preview', error)
    const message = error instanceof Error ? error.message : String(error)
    errorMessage.value = `Failed to start preview: ${message}`
    toast.error(errorMessage.value)
  }
}

async function cancelPreviewLoad() {
  const previewLoad = pendingPreviewLoad.value
  if (!previewLoad)
    return

  pendingPreviewLoad.value = null
  debugLog('preview load canceled', { source: previewLoad.source, url: previewLoad.url })
  statusMessage.value = previewLoad.source === 'camera' ? '' : 'Preview loading canceled'
  if (previewLoad.source === 'camera' && isNativePlatform)
    await startScanner()
}

onMounted(async () => {
  displayStore.NavTitle = 'Scan QR'
  displayStore.defaultBack = '/login'
  debugLog('scan page mounted', { isNativePlatform, previewQuery: route.query.preview })

  const previewLink = Array.isArray(route.query.preview) ? route.query.preview[0] : route.query.preview
  const nativeConfirmedPreview = route.query.nativeConfirmedPreview === '1'
  if (previewLink) {
    debugLog('handling preview query parameter', { nativeConfirmedPreview, previewLink })
    await handleBarcodeScan(previewLink, 'link', { nativeConfirmed: nativeConfirmedPreview })
    await refreshSavedPreviews(true)
    return
  }

  if (!isNativePlatform) {
    debugLog('native scanner unavailable on web platform')
    statusMessage.value = 'Live camera scanning is available in the iOS and Android app. Paste a preview link or bundle URL below.'
    showOptions.value = true
    return
  }
  await refreshSavedPreviews(true)
  await startScanner()
})

onUnmounted(async () => {
  debugLog('scan page unmounting')
  await stopScanner(true)
  await removeDownloadListener()
})

async function removeDownloadListener() {
  if (!downloadListener)
    return

  debugLog('removing download listener')
  const listener = downloadListener
  downloadListener = null
  try {
    await listener.remove()
  }
  catch (error) {
    debugWarn('failed to remove download listener', error)
  }
}

async function refreshSavedPreviews(silent = false) {
  if (!isNativePlatform || !previewManagerAvailable.value)
    return

  if (typeof previewManagerUpdater.listPreviews !== 'function') {
    previewManagerAvailable.value = false
    return
  }

  isLoadingPreviews.value = true
  try {
    const result = await previewManagerUpdater.listPreviews()
    savedPreviews.value = result.previews
    savedPreviewCurrent.value = result.current ?? null
    savedPreviewLiveBundle.value = result.liveBundle ?? null
    previewManagerAvailable.value = true
    debugLog('saved previews refreshed', {
      count: result.previews.length,
      current: result.current?.id,
      liveBundle: result.liveBundle?.id,
    })
  }
  catch (error) {
    previewManagerAvailable.value = false
    if (!silent)
      debugWarn('preview manager unavailable', error)
  }
  finally {
    isLoadingPreviews.value = false
  }
}

async function runPreviewAction(preview: PreviewInfo | null, actionName: string, action: () => Promise<void>) {
  if (isLoading.value || previewActionId.value)
    return

  previewActionId.value = preview?.id || actionName
  previewActionName.value = actionName
  try {
    if (isScanning.value || cameraPreviewStarted)
      await stopScanner(true)
    await action()
    await refreshSavedPreviews()
  }
  catch (error) {
    debugWarn(`failed to ${actionName} preview`, error)
    const message = error instanceof Error ? error.message : String(error)
    toast.error(message)
  }
  finally {
    previewActionId.value = ''
    previewActionName.value = ''
  }
}

async function switchSavedPreview(preview: PreviewInfo) {
  await runPreviewAction(preview, 'switch', async () => {
    if (typeof previewManagerUpdater.setPreview !== 'function')
      throw new Error('Preview manager is not available in this app version')

    toast.success(`Opening ${previewLabel(preview)}`)
    await previewManagerUpdater.setPreview({ id: preview.id })
  })
}

async function updateSavedPreview(preview: PreviewInfo) {
  if (!preview.payloadUrl) {
    toast.error('This preview cannot be updated locally')
    return
  }

  await runPreviewAction(preview, 'update', async () => {
    if (typeof previewManagerUpdater.updatePreview !== 'function')
      throw new Error('Preview manager is not available in this app version')

    const result = await previewManagerUpdater.updatePreview({ id: preview.id })
    toast.success(result.updated ? `Updated ${previewLabel(result.preview)}` : `${previewLabel(result.preview)} is up to date`)
  })
}

async function deleteSavedPreview(preview: PreviewInfo) {
  if (preview.isActive) {
    toast.error('Leave or switch preview before deleting it')
    return
  }

  await runPreviewAction(preview, 'delete', async () => {
    if (typeof previewManagerUpdater.deletePreview !== 'function')
      throw new Error('Preview manager is not available in this app version')

    const result = await previewManagerUpdater.deletePreview({ id: preview.id })
    toast.success(result.deleted ? `Deleted ${previewLabel(preview)}` : `Removed ${previewLabel(preview)}`)
  })
}

async function resetToMainApp() {
  await runPreviewAction(null, 'reset', async () => {
    if (typeof previewManagerUpdater.resetPreview !== 'function')
      throw new Error('Preview manager is not available in this app version')

    toast.success('Returning to main app')
    await previewManagerUpdater.resetPreview()
  })
}

async function removeScannerListeners() {
  if (barcodeScannedListener || barcodeScanErrorListener)
    debugLog('removing barcode listeners')

  const listeners = [
    barcodeScannedListener,
    barcodeScanErrorListener,
  ].filter((listener): listener is PluginListenerHandle => !!listener)
  barcodeScannedListener = null
  barcodeScanErrorListener = null

  await Promise.all(listeners.map(async (listener) => {
    try {
      await listener.remove()
    }
    catch (error) {
      debugWarn('failed to remove barcode listener', error)
    }
  }))
}

function clearBarcodeWatchdog() {
  if (!barcodeWatchdogTimer)
    return

  clearTimeout(barcodeWatchdogTimer)
  barcodeWatchdogTimer = null
}

function startBarcodeWatchdog(startResult: unknown) {
  clearBarcodeWatchdog()
  barcodeWatchdogTimer = setTimeout(async () => {
    barcodeWatchdogTimer = null

    if (!isScanning.value || isHandlingBarcode)
      return

    let previewSize: unknown
    try {
      previewSize = await CameraPreview.getPreviewSize()
    }
    catch (error) {
      previewSize = formatDebugData(error)
    }

    debugLog('barcode scanner still waiting for QR', {
      diagnostics: getScannerDiagnostics(),
      previewSize,
      startResult,
    })
  }, 2500)
}

function getScannerDiagnostics() {
  const rect = scannerFrameRef.value?.getBoundingClientRect()
  const visualViewport = window.visualViewport

  return {
    cameraPreviewStarted,
    devicePixelRatio: window.devicePixelRatio,
    documentVisibility: document.visibilityState,
    frame: rect
      ? {
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
        }
      : null,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    isHandlingBarcode,
    isScanning: isScanning.value,
    scrollY: Math.round(window.scrollY),
    visualViewport: visualViewport
      ? {
          height: Math.round(visualViewport.height),
          offsetTop: Math.round(visualViewport.offsetTop),
          width: Math.round(visualViewport.width),
        }
      : null,
  }
}

function setCameraPreviewActive(active: boolean) {
  document.documentElement.classList.toggle('camera-preview-active', active)
  document.body.classList.toggle('camera-preview-active', active)
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function getScannerFrame() {
  const frame = scannerFrameRef.value
  if (!frame)
    throw new Error('Scanner frame is not ready')

  const rect = frame.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1)
    throw new Error('Scanner frame is not visible')

  return {
    height: Math.round(rect.height),
    width: Math.round(rect.width),
    x: Math.round(rect.left),
    y: Math.round(rect.top),
  }
}

async function stopScanner(force = false, options: { keepHandlingBarcode?: boolean } = {}) {
  const keepHandlingBarcode = options.keepHandlingBarcode ?? false
  debugLog('stopScanner called', { cameraPreviewStarted, force, isScanning: isScanning.value, keepHandlingBarcode })
  clearBarcodeWatchdog()

  if (!cameraPreviewStarted && !force) {
    isScanning.value = false
    setCameraPreviewActive(false)
    await removeScannerListeners()
    if (!keepHandlingBarcode)
      isHandlingBarcode = false
    debugLog('scanner stopped without native stop')
    return
  }

  try {
    await CameraPreview.stopBarcodeScanner()
    debugLog('native barcode scanner stopped')
  }
  catch (error) {
    debugWarn('failed to stop barcode scanner', error)
  }

  try {
    await CameraPreview.stop({ force: true })
    debugLog('camera preview stopped')
  }
  catch (error) {
    debugWarn('failed to stop camera preview', error)
  }

  cameraPreviewStarted = false
  isScanning.value = false
  setCameraPreviewActive(false)
  await removeScannerListeners()
  if (!keepHandlingBarcode)
    isHandlingBarcode = false
  debugLog('scanner state cleared')
}

async function startScanner() {
  if (!isNativePlatform) {
    debugLog('startScanner ignored on web platform')
    statusMessage.value = 'Live camera scanning is available in the iOS and Android app. Paste a preview link or bundle URL below.'
    return
  }

  if (isScanning.value || isLoading.value) {
    debugLog('startScanner ignored because scanner is busy', { isScanning: isScanning.value, isLoading: isLoading.value })
    return
  }

  try {
    debugLog('starting scanner')
    isScanning.value = true
    isHandlingBarcode = false
    errorMessage.value = ''
    statusMessage.value = ''
    scannedUrl.value = ''
    manualUrl.value = ''
    window.scrollTo(0, 0)

    await nextTick()
    const frame = getScannerFrame()
    debugLog('scanner frame measured', frame)

    await removeScannerListeners()
    barcodeScannedListener = await CameraPreview.addListener('barcodeScanned', async ({ barcodes }: BarcodeScannedEvent) => {
      clearBarcodeWatchdog()
      debugLog('barcodeScanned event received', {
        count: barcodes.length,
        values: barcodes.map(barcode => ({
          displayValue: barcode.displayValue,
          format: barcode.format,
          value: barcode.value,
        })),
      })

      if (isHandlingBarcode)
        return

      const barcode = barcodes.find(result => result.value)
      if (!barcode) {
        debugLog('barcode event did not contain a value')
        return
      }

      isHandlingBarcode = true
      debugLog('handling scanned barcode', { format: barcode.format, value: barcode.value })
      try {
        await stopScanner(false, { keepHandlingBarcode: true })
        await handleBarcodeScan(barcode.value, 'camera')
      }
      catch (error) {
        debugWarn('failed to handle scanned barcode', error)
        const message = error instanceof Error ? error.message : String(error)
        errorMessage.value = `Failed to handle scanned QR code: ${message}`
        toast.error(errorMessage.value)
      }
      finally {
        isHandlingBarcode = false
      }
    })
    barcodeScanErrorListener = await CameraPreview.addListener('barcodeScanError', ({ message }: BarcodeScanErrorEvent) => {
      debugWarn('barcode scan error event', message)
    })
    debugLog('barcode listeners attached')

    cameraPreviewStarted = true
    setCameraPreviewActive(true)
    debugLog('camera preview transparency enabled')
    await waitForPaint()

    const startResult = await CameraPreview.start({
      ...frame,
      aspectMode: 'cover',
      disableAudio: true,
      force: true,
      position: 'rear',
      toBack: true,
    })
    debugLog('camera preview started', {
      diagnostics: getScannerDiagnostics(),
      startResult,
    })

    const barcodeScannerOptions: BarcodeScannerOptions = { detectionInterval: 200, formats: ['qr_code'] }
    debugLog('starting native barcode scanner', barcodeScannerOptions)
    await CameraPreview.startBarcodeScanner(barcodeScannerOptions)
    debugLog('native barcode scanner started')
    startBarcodeWatchdog(startResult)
  }
  catch (error) {
    debugWarn('failed to start scanner', error)
    errorMessage.value = 'The camera could not start. Check camera permissions, then tap scan again or paste the link manually.'
    await stopScanner(true)
  }
}

async function handleBarcodeScan(scannedValue: string, source: PreviewLoadSource = 'link', options: HandleBarcodeScanOptions = {}) {
  const value = scannedValue.trim()
  const shouldStartNativeConfirmedPreview = isNativePlatform && source === 'link' && options.nativeConfirmed === true
  debugLog('handleBarcodeScan called', { nativeConfirmed: shouldStartNativeConfirmedPreview, source, value })
  const previewLink = parsePreviewDeepLink(value)
  if (previewLink) {
    debugLog('scan parsed as preview deep link', previewLink)
    scannedUrl.value = value
    manualUrl.value = ''
    if (shouldStartNativeConfirmedPreview) {
      await startPreviewLink(previewLink)
      return
    }

    queuePreviewLoad({
      appLabel: previewLinkAppLabel(previewLink),
      detail: previewLinkDetail(previewLink),
      source,
      start: () => startPreviewLink(previewLink),
      url: value,
    })
    return
  }

  const previewPayloadUrl = previewPayloadUrlFromUrl(value)
  if (previewPayloadUrl) {
    const target = previewHostTargetFromUrl(value)
    debugLog('scan parsed as preview host', { previewPayloadUrl, value })
    scannedUrl.value = value
    manualUrl.value = value
    if (shouldStartNativeConfirmedPreview) {
      await startPreviewPayload(previewPayloadUrl)
      return
    }

    queuePreviewLoad({
      appLabel: target?.appId || hostFromUrl(value) || 'Unknown app',
      detail: previewHostDetail(target),
      source,
      start: () => startPreviewPayload(previewPayloadUrl),
      url: value,
    })
    return
  }

  if (!isHttpUrl(value)) {
    debugWarn('scan value is unsupported', value)
    errorMessage.value = 'This QR code is not a Capgo preview link or an HTTPS bundle URL.'
    manualUrl.value = value
    toast.error('Scanned QR code is not a supported preview link')
    return
  }

  scannedUrl.value = value
  manualUrl.value = value
  debugLog('scan parsed as direct HTTP update URL', value)
  queuePreviewLoad({
    appLabel: hostFromUrl(value) || 'Unknown host',
    detail: 'Direct update URL',
    source,
    start: () => downloadUpdate(value),
    url: value,
  })
}

async function startPreviewSession(metadata: PreviewSessionMetadata = {}) {
  const options: PreviewStartOptions = {}
  if (metadata.appId)
    options.appId = metadata.appId
  if (metadata.payloadUrl)
    options.payloadUrl = metadata.payloadUrl
  if (metadata.name)
    options.name = metadata.name
  if (metadata.source)
    options.source = metadata.source

  const hasOptions = Object.keys(options).length > 0
  debugLog('starting preview session', {
    appId: options.appId,
    hasPayloadUrl: !!options.payloadUrl,
    name: options.name,
    payloadUrl: options.payloadUrl,
    source: options.source,
  })
  await CapacitorUpdater.startPreviewSession(hasOptions ? options : undefined)
  debugLog('preview session started', {
    appId: options.appId,
    hasPayloadUrl: !!options.payloadUrl,
    name: options.name,
    payloadUrl: options.payloadUrl,
    source: options.source,
  })
}

function parsePreviewPayloadBody(data: unknown, status: number) {
  if (typeof data !== 'string')
    return data

  try {
    return JSON.parse(data)
  }
  catch {
    throw new Error(data || `Preview payload request failed with HTTP ${status}`)
  }
}

function stringFromPayloadValue(value: unknown) {
  if (value === undefined || value === null)
    return ''

  if (typeof value === 'string')
    return value

  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)

  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function previewPayloadErrorMessage(payload: unknown, status: number) {
  if (typeof payload === 'object' && payload) {
    const payloadRecord = payload as Record<string, unknown>
    for (const key of ['message', 'error', 'details', 'detail']) {
      const message = stringFromPayloadValue(payloadRecord[key])
      if (message)
        return message
    }
  }

  return `Preview payload request failed with HTTP ${status}`
}

function validatePreviewPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object')
    throw new Error('Preview payload is invalid')

  return payload as PreviewPayload
}

async function previewPayloadFromResponse(response: Response): Promise<PreviewPayload> {
  const text = await response.text()
  debugLog('browser preview payload body received', {
    body: text,
    status: response.status,
  })
  const payload = parsePreviewPayloadBody(text, response.status)

  if (!response.ok)
    throw new Error(previewPayloadErrorMessage(payload, response.status))

  return validatePreviewPayload(payload)
}

function previewPayloadFromHttpResponse(response: HttpResponse): PreviewPayload {
  const payload = parsePreviewPayloadBody(response.data, response.status)

  if (response.status < 200 || response.status >= 300)
    throw new Error(previewPayloadErrorMessage(payload, response.status))

  return validatePreviewPayload(payload)
}

async function fetchPreviewPayloadWithNativeHttp(payloadUrl: string) {
  const response = await CapacitorHttp.get({
    headers: { Accept: 'application/json' },
    responseType: 'text',
    url: payloadUrl,
  })
  debugLog('native preview payload response received', {
    body: response.data,
    dataType: typeof response.data,
    status: response.status,
    url: response.url,
  })
  return previewPayloadFromHttpResponse(response)
}

async function fetchPreviewPayloadWithBrowserFetch(payloadUrl: string) {
  const response = await fetch(payloadUrl, {
    headers: { Accept: 'application/json' },
  })
  debugLog('browser preview payload response received', {
    ok: response.ok,
    status: response.status,
    url: response.url,
  })
  return previewPayloadFromResponse(response)
}

async function fetchPreviewPayload(payloadUrl: string) {
  debugLog('fetching preview payload', {
    payloadUrl,
    transport: isNativePlatform ? 'native-http' : 'fetch',
  })
  const payload = isNativePlatform
    ? await fetchPreviewPayloadWithNativeHttp(payloadUrl)
    : await fetchPreviewPayloadWithBrowserFetch(payloadUrl)
  if (!payload.version)
    throw new Error('Preview payload is missing a version')
  if (!payload.url && !payload.manifest?.length)
    throw new Error('Preview payload is missing download information')
  debugLog('preview payload received', {
    appId: payload.appId,
    hasManifest: !!payload.manifest?.length,
    hasUrl: !!payload.url,
    version: payload.version,
  })
  return payload
}

function downloadOptionsFromPreviewPayload(payload: PreviewPayload): DownloadOptions {
  if (!payload.version)
    throw new Error('Preview payload is missing a version')
  if (!payload.url)
    throw new Error('Preview payload is missing a bundle URL')

  return {
    checksum: payload.checksum ?? undefined,
    manifest: payload.manifest,
    sessionKey: payload.sessionKey ?? undefined,
    url: payload.url,
    version: payload.version,
  }
}

function isPreviewPayloadEndpointUrl(value: string) {
  const parsedUrl = parseSafeUrl(value)
  return parsedUrl?.pathname === PREVIEW_PAYLOAD_PATH || parsedUrl?.pathname.endsWith('.json')
}

function previewVersionFromLink(previewLink: PreviewDeepLink) {
  if (previewLink.type === 'bundle' && typeof previewLink.versionId === 'number')
    return `preview-${previewLink.versionId}`
  if (previewLink.type === 'channel' && typeof previewLink.channelId === 'number')
    return `preview-channel-${previewLink.channelId}-${Date.now()}`
  return `preview-${Date.now()}`
}

function resolvePreviewPayloadUrl(payloadUrl: string) {
  const target = previewHostTargetFromUrl(payloadUrl)
  const parsedUrl = parseSafeUrl(payloadUrl)
  if (target && parsedUrl?.pathname !== PREVIEW_PAYLOAD_PATH) {
    debugLog('preview host converted to payload endpoint', {
      payloadUrl: target.payloadUrl,
      rootUrl: target.rootUrl,
    })
    return target.payloadUrl
  }

  return payloadUrl
}

async function fetchPreviewPayloadResolved(payloadUrl: string): Promise<PreviewPayloadFetchResult> {
  const resolvedPayloadUrl = resolvePreviewPayloadUrl(payloadUrl)
  return {
    payload: await fetchPreviewPayload(resolvedPayloadUrl),
    sessionPayloadUrl: resolvedPayloadUrl,
  }
}

async function startPreviewPayload(payloadUrl: string, appId?: string) {
  try {
    debugLog('starting preview payload flow', { appId, payloadUrl })
    isLoading.value = true
    downloadProgress.value = 0

    await removeDownloadListener()
    downloadListener = await CapacitorUpdater.addListener('download', (state: DownloadEvent) => {
      downloadProgress.value = state.percent || 0
      debugLog('download progress', { percent: state.percent })
    })

    toast.success('Starting preview')

    const { payload, sessionPayloadUrl } = await fetchPreviewPayloadResolved(payloadUrl)
    const bundle = await CapacitorUpdater.download(downloadOptionsFromPreviewPayload(payload))
    debugLog('preview payload downloaded', bundle)

    await startPreviewSession({
      appId: payload.appId || appId,
      name: payload.version ? `Preview ${payload.version}` : previewNameFromUrl(sessionPayloadUrl || payloadUrl),
      payloadUrl: sessionPayloadUrl,
      source: 'payload',
    })
    await CapacitorUpdater.set(bundle)
    await refreshSavedPreviews(true)
    debugLog('preview payload applied', bundle)
  }
  catch (error) {
    debugWarn('failed to start preview payload flow', error)
    const message = error instanceof Error ? error.message : String(error)
    errorMessage.value = `Failed to start preview: ${message}`
    manualUrl.value = scannedUrl.value
    toast.error(errorMessage.value)
  }
  finally {
    isLoading.value = false
    await removeDownloadListener()
  }
}

async function startPreviewLink(previewLink: PreviewDeepLink) {
  debugLog('starting preview link', previewLink)
  if (previewLink.payloadUrl) {
    if (isPreviewPayloadEndpointUrl(previewLink.payloadUrl))
      await startPreviewPayload(previewLink.payloadUrl, previewLink.appId)
    else
      await startPreviewDownloadUrl(previewLink.payloadUrl, previewVersionFromLink(previewLink), previewLink.appId)
    return
  }

  if (previewLink.type === 'channel') {
    const previewPayloadUrl = previewPayloadUrlFromChannelLink(previewLink)
    if (previewPayloadUrl) {
      debugLog('channel preview link converted to preview payload endpoint', { previewPayloadUrl })
      await startPreviewPayload(previewPayloadUrl, previewLink.appId)
      return
    }
  }

  if (previewLink.type === 'bundle') {
    const previewPayloadUrl = previewPayloadUrlFromBundleLink(previewLink)
    if (previewPayloadUrl) {
      debugLog('bundle preview link converted to preview payload endpoint', { previewPayloadUrl })
      await startPreviewPayload(previewPayloadUrl, previewLink.appId)
      return
    }
  }

  if (previewLink.type === 'channel')
    await startChannelPreview(previewLink)
}

async function startChannelPreview(previewLink: Extract<PreviewDeepLink, { type: 'channel' }>) {
  try {
    debugLog('starting channel preview flow', previewLink)
    isLoading.value = true
    downloadProgress.value = 0

    await removeDownloadListener()
    downloadListener = await CapacitorUpdater.addListener('download', (state: DownloadEvent) => {
      downloadProgress.value = state.percent || 0
      debugLog('download progress', { percent: state.percent })
    })

    toast.success('Starting preview')

    const latest = await CapacitorUpdater.getLatest(buildChannelPreviewLatestOptions(previewLink))
    debugLog('latest preview response received', {
      error: latest.error,
      hasManifest: !!latest.manifest?.length,
      hasUrl: !!latest.url,
      message: latest.message,
      version: latest.version,
    })
    if (!latest.url)
      throw new Error(latest.message || latest.error || 'No preview update is available for this channel')

    const bundle = await CapacitorUpdater.download({
      checksum: latest.checksum,
      manifest: latest.manifest,
      sessionKey: latest.sessionKey,
      url: latest.url,
      version: latest.version,
    })
    debugLog('channel preview downloaded', bundle)

    await startPreviewSession({
      appId: previewLink.appId,
      name: previewLink.channelName ? `${previewLink.channelName} preview` : `Channel ${previewLink.channelId}`,
      source: 'channel',
    })
    await CapacitorUpdater.set(bundle)
    await refreshSavedPreviews(true)
    debugLog('channel preview applied', bundle)
  }
  catch (error) {
    debugWarn('failed to start channel preview flow', error)
    const message = error instanceof Error ? error.message : String(error)
    errorMessage.value = `Failed to start preview: ${message}`
    manualUrl.value = scannedUrl.value
    toast.error(errorMessage.value)
  }
  finally {
    isLoading.value = false
    await removeDownloadListener()
  }
}

async function startPreviewDownloadUrl(downloadUrl: string, version = `preview-${Date.now()}`, appId?: string) {
  try {
    debugLog('starting direct preview download flow', { appId, downloadUrl, version })
    isLoading.value = true
    downloadProgress.value = 0

    await removeDownloadListener()
    downloadListener = await CapacitorUpdater.addListener('download', (state: DownloadEvent) => {
      downloadProgress.value = state.percent || 0
      debugLog('download progress', { percent: state.percent })
    })

    toast.success(`Starting preview from ${new URL(downloadUrl).host}`)

    const bundle = await CapacitorUpdater.download({
      url: downloadUrl,
      version,
    })
    debugLog('direct preview downloaded', bundle)

    await startPreviewSession({
      appId,
      name: version,
      source: 'url',
    })
    await CapacitorUpdater.set(bundle)
    await refreshSavedPreviews(true)
    debugLog('direct preview applied', bundle)
  }
  catch (error) {
    debugWarn('failed to download/apply direct preview', error)
    const message = error instanceof Error ? error.message : String(error)
    errorMessage.value = `Failed to start preview: ${message}`
    manualUrl.value = scannedUrl.value
    toast.error(errorMessage.value)
  }
  finally {
    isLoading.value = false
    await removeDownloadListener()
  }
}

async function downloadUpdate(updateUrl: string) {
  debugLog('downloadUpdate called', updateUrl)
  const previewLink = parsePreviewDeepLink(updateUrl)
  if (previewLink) {
    await startPreviewLink(previewLink)
    return
  }

  const previewPayloadUrl = previewPayloadUrlFromUrl(updateUrl)
  if (previewPayloadUrl) {
    await startPreviewPayload(previewPayloadUrl)
    return
  }

  if (!isHttpUrl(updateUrl)) {
    debugWarn('downloadUpdate rejected unsupported URL', updateUrl)
    errorMessage.value = 'This is not a downloadable bundle URL. Use a Capgo preview QR code or an HTTPS bundle URL.'
    toast.error('Unsupported update URL')
    return
  }

  await startPreviewDownloadUrl(updateUrl, `scan-${Date.now()}`)
}

async function submitManualUrl() {
  debugLog('submitManualUrl called', normalizedManualUrl.value)
  if (!canSubmitManualUrl.value) {
    toast.error('Enter a valid preview link or update URL')
    return
  }

  errorMessage.value = ''
  statusMessage.value = ''
  scannedUrl.value = normalizedManualUrl.value

  if (isScanning.value || cameraPreviewStarted)
    await stopScanner(true)

  if (manualPreviewLink.value) {
    await startPreviewLink(manualPreviewLink.value)
    return
  }

  if (manualPreviewPayloadUrl.value) {
    await startPreviewPayload(manualPreviewPayloadUrl.value)
    return
  }

  if (!isNativePlatform) {
    toast.success(`Opening ${new URL(normalizedManualUrl.value).host}`)
    window.location.assign(normalizedManualUrl.value)
    return
  }

  await downloadUpdate(normalizedManualUrl.value)
}

async function retryScanning() {
  debugLog('retryScanning called')
  errorMessage.value = ''
  statusMessage.value = ''
  scannedUrl.value = ''
  manualUrl.value = ''
  downloadProgress.value = 0
  await stopScanner(true)
  await startScanner()
}

async function goBack() {
  if (window.history.length > 1) {
    await router.back()
    return
  }

  await router.push('/login')
}
</script>

<template>
  <main
    class="camera-preview-page fixed inset-0 h-dvh overflow-hidden text-white"
    :class="isScanning ? 'bg-transparent' : 'bg-slate-950'"
  >
    <div v-if="!isScanning" class="absolute inset-0 bg-slate-950" />
    <div
      v-else
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_42%,rgba(2,6,23,0.72)_100%)]"
    />

    <div class="relative z-10 mx-auto flex h-dvh w-full max-w-md flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
      <header class="grid shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center">
        <button
          class="inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition-opacity active:opacity-70"
          aria-label="Go back"
          @click="goBack"
        >
          <IconArrowLeft class="h-5 w-5" />
        </button>
        <h1 class="truncate text-center text-base font-semibold text-white">
          Scan QR Code
        </h1>
      </header>

      <section class="flex min-h-0 flex-1 flex-col items-center justify-center py-4">
        <div
          ref="scannerFrameRef"
          class="scan-camera-frame relative aspect-square w-full max-w-[min(88vw,19rem,46dvh)] shrink-0 overflow-hidden rounded-3xl"
          :class="isScanning ? 'bg-transparent' : 'bg-slate-900/80 ring-1 ring-white/10'"
        >
          <div v-if="!isScanning" class="absolute inset-0 flex items-center justify-center bg-slate-900/90">
            <IconQrCode class="h-16 w-16 text-slate-600" aria-hidden="true" />
          </div>
          <div
            v-if="isScanning"
            class="scanner-sweep absolute inset-x-8 top-8 h-px bg-azure-400/90 shadow-[0_0_16px_rgba(17,158,255,0.85)]"
          />
          <div class="pointer-events-none absolute inset-5">
            <div class="absolute left-0 top-0 h-8 w-8 rounded-tl-xl border-l-[3px] border-t-[3px] border-white/90" />
            <div class="absolute right-0 top-0 h-8 w-8 rounded-tr-xl border-r-[3px] border-t-[3px] border-white/90" />
            <div class="absolute bottom-0 left-0 h-8 w-8 rounded-bl-xl border-b-[3px] border-l-[3px] border-white/90" />
            <div class="absolute bottom-0 right-0 h-8 w-8 rounded-br-xl border-b-[3px] border-r-[3px] border-white/90" />
          </div>
        </div>

        <div class="mt-5 w-full max-w-sm space-y-3 text-center" aria-live="polite">
          <p
            v-if="!errorMessage"
            class="text-sm leading-6 text-white/75"
          >
            {{ scannerHint }}
          </p>

          <div v-if="isLoading" class="space-y-2 px-1">
            <div class="flex items-center justify-between text-xs font-medium text-white/70">
              <span>Downloading preview</span>
              <span>{{ progressPercentage }}%</span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                class="h-full rounded-full bg-azure-500 transition-all duration-300 ease-out"
                :style="{ width: `${downloadProgress}%` }"
              />
            </div>
            <p v-if="downloadHost" class="truncate text-xs text-white/45">
              {{ downloadHost }}
            </p>
          </div>

          <p
            v-if="errorMessage"
            class="rounded-2xl bg-amber-400/10 px-4 py-3 text-left text-sm leading-6 text-amber-100"
            role="alert"
          >
            {{ errorMessage }}
          </p>
        </div>
      </section>

      <section class="shrink-0 space-y-3">
        <button
          v-if="isNativePlatform"
          class="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-azure-500 px-4 py-3 text-sm font-semibold text-white transition-opacity active:opacity-80 disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="isScanning || isLoading"
          @click="retryScanning"
        >
          <IconArrowPath v-if="errorMessage || statusMessage" class="h-5 w-5" />
          <IconQrCode v-else class="h-5 w-5" />
          {{ isScanning ? 'Camera open' : errorMessage || statusMessage ? 'Scan again' : 'Scan QR code' }}
        </button>

        <button
          type="button"
          class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white/90 transition-colors active:bg-white/10"
          :aria-expanded="showOptions"
          @click="showOptions = !showOptions"
        >
          <IconEllipsisHorizontal class="h-5 w-5 text-white/70" />
          More options
          <IconChevronDown
            class="h-4 w-4 text-white/50 transition-transform duration-200"
            :class="showOptions ? 'rotate-180' : ''"
          />
        </button>

        <div
          v-show="showOptions"
          class="max-h-[34dvh] space-y-3 overflow-y-auto overscroll-contain pr-0.5"
        >
          <div class="rounded-2xl border border-white/10 bg-black/25 p-4 backdrop-blur-sm">
            <label class="block text-sm font-medium text-white/90" for="manual-url">
              Paste preview link
            </label>
            <input
              id="manual-url"
              v-model="manualUrl"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="https://preview.capgo.app/..."
              class="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-hidden transition-colors placeholder:text-slate-500 focus:border-azure-500/60"
            >
            <button
              class="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white transition-colors active:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45"
              :disabled="!canSubmitManualUrl"
              @click="submitManualUrl"
            >
              <IconLink class="h-4 w-4" />
              {{ manualActionLabel }}
            </button>
          </div>

          <details v-if="hasSavedPreviewPanel" class="rounded-2xl border border-white/10 bg-black/25 backdrop-blur-sm">
            <summary class="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-white/90 [&::-webkit-details-marker]:hidden">
              <IconRectangleStack class="h-5 w-5 text-azure-400" />
              Saved previews
              <span v-if="savedPreviews.length" class="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
                {{ savedPreviews.length }}
              </span>
              <IconChevronDown class="h-4 w-4 text-white/45" />
            </summary>

            <div class="space-y-2 border-t border-white/10 px-4 pb-4 pt-3">
              <div v-if="savedPreviewCurrent || savedPreviewLiveBundle" class="flex items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2.5">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-white">
                    {{ savedPreviewCurrent ? previewLabel(savedPreviewCurrent) : 'Main app' }}
                  </p>
                  <p class="truncate text-xs text-white/50">
                    {{ savedPreviewCurrent ? 'Current preview' : `Main ${bundleVersion(savedPreviewLiveBundle)}` }}
                  </p>
                </div>
                <button
                  v-if="savedPreviewCurrent"
                  type="button"
                  aria-label="Return to main app"
                  class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white transition-colors active:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45"
                  :disabled="!!previewActionId || isLoading"
                  @click="resetToMainApp"
                >
                  <IconArrowUturnLeft class="h-4 w-4" />
                </button>
              </div>

              <div v-if="isLoadingPreviews" class="rounded-xl px-3 py-2 text-xs text-white/50">
                Loading previews...
              </div>

              <ol v-else-if="savedPreviews.length" class="space-y-2">
                <li
                  v-for="preview in savedPreviews"
                  :key="preview.id"
                  class="rounded-xl bg-white/5 px-3 py-2.5"
                >
                  <div class="flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-white">
                        {{ previewLabel(preview) }}
                      </p>
                      <p class="truncate text-xs text-white/50">
                        {{ previewSubtitle(preview) }}
                      </p>
                    </div>
                    <span v-if="preview.isActive" class="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                      Active
                    </span>
                  </div>

                  <div class="mt-2 flex gap-2">
                    <button
                      type="button"
                      aria-label="Open preview"
                      class="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-azure-500/20 text-xs font-semibold text-azure-200 transition-colors active:bg-azure-500/30 disabled:cursor-not-allowed disabled:opacity-45"
                      :disabled="preview.isActive || !!previewActionId || isLoading"
                      @click="switchSavedPreview(preview)"
                    >
                      <IconPlay class="h-4 w-4" />
                      Open
                    </button>
                    <button
                      type="button"
                      aria-label="Update preview"
                      class="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white transition-colors active:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45"
                      :disabled="!preview.payloadUrl || !!previewActionId || isLoading"
                      @click="updateSavedPreview(preview)"
                    >
                      <IconArrowPath class="h-4 w-4" :class="previewActionId === preview.id && previewActionName === 'update' ? 'animate-spin' : ''" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete preview"
                      class="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-rose-400/10 text-rose-200 transition-colors active:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-45"
                      :disabled="preview.isActive || !!previewActionId || isLoading"
                      @click="deleteSavedPreview(preview)"
                    >
                      <IconTrash class="h-4 w-4" />
                    </button>
                  </div>
                </li>
              </ol>
            </div>
          </details>

          <details v-if="debugMessages.length" class="rounded-2xl border border-white/10 bg-black/25 backdrop-blur-sm">
            <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-white/70 [&::-webkit-details-marker]:hidden">
              Debug logs
              <span class="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/50">
                {{ debugMessages.length }}
              </span>
              <IconChevronDown class="ml-auto h-4 w-4 text-white/45" />
            </summary>
            <div class="border-t border-white/10 px-4 pb-4 pt-3">
              <button
                type="button"
                class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-medium text-white transition-colors active:bg-white/15"
                @click="copyDebugLogs"
              >
                <IconClipboard class="h-4 w-4" />
                Copy logs
              </button>
              <ol class="mt-3 max-h-32 space-y-1 overflow-y-auto font-mono text-[11px] leading-5 text-white/45">
                <li v-for="message in debugMessages" :key="message">
                  {{ message }}
                </li>
              </ol>
            </div>
          </details>
        </div>
      </section>
    </div>

    <div
      v-if="pendingPreviewLoad"
      class="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/85 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-confirm-title"
    >
      <div class="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 text-left shadow-2xl">
        <div class="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-azure-500/15 text-azure-300">
          <IconPlay class="h-5 w-5" />
        </div>
        <h2 id="preview-confirm-title" class="text-lg font-semibold text-white">
          {{ previewConfirmTitle }}
        </h2>
        <p class="mt-2 text-sm leading-6 text-white/65">
          {{ previewConfirmDescription }}
        </p>

        <dl class="mt-5 divide-y divide-white/10 border-y border-white/10">
          <div class="py-3">
            <dt class="text-xs font-medium uppercase text-white/40">
              App
            </dt>
            <dd class="mt-1 break-all text-sm font-semibold text-white">
              {{ pendingPreviewLoad.appLabel }}
            </dd>
          </div>
          <div class="py-3">
            <dt class="text-xs font-medium uppercase text-white/40">
              Target
            </dt>
            <dd class="mt-1 break-all text-sm text-white/75">
              {{ pendingPreviewLoad.detail }}
            </dd>
          </div>
        </dl>

        <div class="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            class="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white/80 transition-colors active:bg-white/10"
            @click="cancelPreviewLoad"
          >
            No
          </button>
          <button
            type="button"
            class="inline-flex min-h-11 items-center justify-center rounded-xl bg-azure-500 px-4 text-sm font-semibold text-white transition-colors active:bg-azure-600"
            @click="confirmPreviewLoad"
          >
            Load preview
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.camera-preview-page {
  overscroll-behavior: none;
  touch-action: manipulation;
}

.scanner-sweep {
  animation: scanner-sweep 2.2s ease-in-out infinite;
}

@keyframes scanner-sweep {
  0%,
  100% {
    top: 1.75rem;
    opacity: 0.35;
  }

  50% {
    top: calc(100% - 1.75rem);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .scanner-sweep {
    animation: none;
    opacity: 0.75;
    top: 50%;
  }
}
</style>

<style>
html.camera-preview-active,
body.camera-preview-active,
body.camera-preview-active #app,
body.camera-preview-active #app > .app-shell,
body.camera-preview-active .camera-preview-page,
body.camera-preview-active .scan-camera-frame {
  background: transparent !important;
  background-color: transparent !important;
}

html.camera-preview-active,
body.camera-preview-active {
  overflow: hidden !important;
}
</style>

<route lang="yaml">
meta:
  layout: naked
</route>

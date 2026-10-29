import type { AppUsageByApp, AppUsageGlobal, Plan } from './../services/console'
import type { User } from '~/services/consoleClient'
import type { Database } from '~/types/database.types'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  clearSpoof,
  findBestPlan,
  getAllDashboard,
  getLocalConfig,
  getTotalStorage,
  isPlatformAdmin,
  normalizeDashboardDateRange,
  useConsole,
} from '~/services/console'
import { getDaysBetweenDates } from '~/services/conversion'
import { normalizeToUtcStartOfDay } from '~/services/date'
import { reset } from '~/services/posthog'
import { setWebsitePaidUserCookie } from '~/services/websiteAuthCookie'
import { createDeferredPromise } from '../utils/promise'

interface TotalStats {
  mau: number
  storage: number
  bandwidth: number
  build_time_seconds: number
}

export const useMainStore = defineStore('main', () => {
  const auth = ref<User | undefined>()
  const authGeneration = ref(0)
  const path = ref('')
  const user = ref<Database['public']['Tables']['users']['Row']>()
  const plans = ref<Plan[]>([])
  const totalStats = ref<TotalStats>({
    mau: 0,
    storage: 0,
    bandwidth: 0,
    build_time_seconds: 0,
  })
  const bestPlan = ref<string>('')
  const statsTime = ref<{ next_run: string, last_run: string }>({
    next_run: '',
    last_run: '',
  })
  const isAdmin = ref<boolean>(false)
  let platformAdminStatusGeneration = -1
  let platformAdminStatusEpoch = 0
  let platformAdminStatusRequest: { epoch: number, generation: number, promise: Promise<boolean> } | undefined
  const dashboard = ref<AppUsageGlobal[]>([])
  const dashboardOrgId = ref<string | null>(null)
  const dashboardByapp = ref<AppUsageByApp[]>([])
  const totalDevices = ref<number>(0)
  const totalStorage = ref<number>(0)
  const dashboardFetched = ref<boolean>(false)
  const _initialLoadPromise = ref(createDeferredPromise<boolean>())
  let dashboardLoadId = 0
  let dashboardRequest: { orgId: string, start: string, end: string, generation: number, promise: Promise<void> } | undefined

  const totalDownload = ref<number>(0)

  const invalidatePlatformAdminStatus = () => {
    platformAdminStatusEpoch += 1
    platformAdminStatusGeneration = -1
    platformAdminStatusRequest = undefined
    isAdmin.value = false
  }

  const resolvePlatformAdminStatus = async () => {
    const generation = authGeneration.value
    const epoch = platformAdminStatusEpoch
    if (platformAdminStatusGeneration === generation)
      return isAdmin.value
    if (platformAdminStatusRequest?.generation === generation && platformAdminStatusRequest.epoch === epoch)
      return platformAdminStatusRequest.promise

    const promise: Promise<boolean> = isPlatformAdmin()
      .then((status) => {
        if (authGeneration.value === generation && platformAdminStatusEpoch === epoch) {
          isAdmin.value = status
          platformAdminStatusGeneration = generation
          if (status)
            setWebsitePaidUserCookie(true)
        }
        return status
      })
      .finally(() => {
        if (platformAdminStatusRequest?.promise === promise)
          platformAdminStatusRequest = undefined
      })

    platformAdminStatusRequest = { epoch, generation, promise }
    return promise
  }

  const refreshPlatformAdminStatus = () => {
    invalidatePlatformAdminStatus()
    return resolvePlatformAdminStatus()
  }

  watch(auth, () => {
    authGeneration.value += 1
    dashboardOrgId.value = null
    invalidatePlatformAdminStatus()
  }, { flush: 'sync' })

  const logout = async () => {
    const capgo = useConsole()
    const config = getLocalConfig()
    const { error } = await capgo.auth.signOut()
    auth.value = undefined
    user.value = undefined
    isAdmin.value = false
    reset(config.apiHost)
    clearSpoof()
    if (error)
      console.error('Failed to log out', error)
  }

  const getTotalStats: () => TotalStats = () => {
    return dashboard.value.reduce((acc: TotalStats, cur: AppUsageGlobal) => {
      acc.mau += cur.mau
      acc.bandwidth += cur.bandwidth
      acc.storage += cur.storage
      acc.build_time_seconds += cur.build_time_seconds
      return acc
    }, {
      mau: 0,
      bandwidth: 0,
      storage: 0,
      build_time_seconds: 0,
    })
  }

  const calculateMonthDay = (subscriptionStart: string | undefined) => {
    // Parse dates consistently using UTC day boundaries (dashboard stats are UTC-bucketed)
    const startDate = normalizeToUtcStartOfDay(subscriptionStart ? new Date(subscriptionStart) : new Date())
    const currentDate = normalizeToUtcStartOfDay()

    const daysInMonth = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() + 1, 0)).getUTCDate()
    return (getDaysBetweenDates(startDate, currentDate) % daysInMonth || daysInMonth) - 1
  }

  const updateDashboard = async (currentOrgId: string, rangeStart?: string, rangeEnd?: string) => {
    const { start, end } = normalizeDashboardDateRange(rangeStart, rangeEnd)
    const generation = authGeneration.value
    if (dashboardRequest?.orgId === currentOrgId && dashboardRequest.start === start && dashboardRequest.end === end && dashboardRequest.generation === generation)
      return dashboardRequest.promise

    const loadId = ++dashboardLoadId
    const isCurrent = () => loadId === dashboardLoadId && generation === authGeneration.value
    const request = (async () => {
      try {
        const dashboardRes = await getAllDashboard(currentOrgId, start, end)
        if (!isCurrent())
          return
        dashboardOrgId.value = currentOrgId
        dashboard.value = dashboardRes.global
        dashboardByapp.value = dashboardRes.byApp

        const monthDay = calculateMonthDay(start)
        totalDevices.value = dashboard.value[monthDay]?.mau ?? 0
        totalDownload.value = dashboard.value[monthDay]?.get ?? 0

        const storage = await getTotalStorage()
        if (!isCurrent())
          return
        totalStorage.value = storage
        totalStats.value = getTotalStats()

        const plan = await findBestPlan(totalStats.value)
        if (!isCurrent())
          return
        bestPlan.value = plan
        dashboardFetched.value = true
        _initialLoadPromise.value.resolve(true)
      }
      catch (error) {
        if (!isCurrent())
          return
        _initialLoadPromise.value.reject(error)
        throw error
      }
    })().finally(() => {
      if (dashboardRequest?.promise === request)
        dashboardRequest = undefined
    })

    dashboardRequest = { orgId: currentOrgId, start, end, generation, promise: request }
    return request
  }

  const filterDashboard = (appId: string) => {
    return dashboardByapp.value.filter(d => d.app_id === appId)
  }

  const getTotalStatsByApp = async (appId: string, subscriptionStart?: string) => {
    const monthDay = calculateMonthDay(subscriptionStart)
    const appData = dashboardByapp.value.filter(d => d.app_id === appId)
    return appData[monthDay]?.get ?? 0
  }
  const getTotalMauByApp = async (appId: string, subscriptionStart?: string) => {
    // Get the app's dashboard data
    const appData = dashboardByapp.value.filter(d => d.app_id === appId)

    // Calculate how many days into the billing cycle we are
    const startDate = normalizeToUtcStartOfDay(subscriptionStart ? new Date(subscriptionStart) : new Date())
    const currentDate = normalizeToUtcStartOfDay()

    // Calculate days in billing cycle
    const daysInBillingCycle = Math.floor((currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1

    // Accumulate only the MAU values within the current billing cycle
    let totalMau = 0
    const dataLength = Math.min(daysInBillingCycle, appData.length)
    for (let i = 0; i < dataLength; i++) {
      if (appData[i]?.mau !== undefined) {
        totalMau += appData[i].mau
      }
    }
    return totalMau
  }

  const awaitInitialLoad = () => {
    return _initialLoadPromise.value.promise
  }

  return {
    auth,
    authGeneration,
    statsTime,
    plans,
    isAdmin,
    invalidatePlatformAdminStatus,
    refreshPlatformAdminStatus,
    resolvePlatformAdminStatus,
    totalStorage,
    totalStats,
    bestPlan,
    totalDevices,
    totalDownload,
    dashboardFetched,
    updateDashboard,
    filterDashboard,
    dashboard,
    dashboardOrgId,
    awaitInitialLoad,
    dashboardByapp,
    getTotalMauByApp,
    getTotalStatsByApp,
    user,
    path,
    logout,
  }
})

if (import.meta.hot)
  import.meta.hot.accept(acceptHMRUpdate(useMainStore, import.meta.hot))

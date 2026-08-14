import type { User } from '@supabase/supabase-js'
import type { AppUsageByApp, AppUsageGlobal } from './../services/supabase'
import type { Database } from '~/types/supabase.types'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { getDaysBetweenDates } from '~/services/conversion'
import { normalizeToUtcStartOfDay } from '~/services/date'
import { reset } from '~/services/posthog'
import {
  clearSpoof,
  findBestPlan,
  getAllDashboard,
  getLocalConfig,
  getTotalStorage,
  normalizeDashboardDateRange,
  useSupabase,
} from '~/services/supabase'
import { createDeferredPromise } from '../utils/promise'

interface TotalStats {
  mau: number
  storage: number
  bandwidth: number
  build_time_seconds: number
}

export const useMainStore = defineStore('main', () => {
  const auth = ref<User | undefined>()
  const path = ref('')
  const user = ref<Database['public']['Tables']['users']['Row']>()
  const plans = ref<Database['public']['Tables']['plans']['Row'][]>([])
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
  const dashboard = ref<AppUsageGlobal[]>([])
  const dashboardByapp = ref<AppUsageByApp[]>([])
  const totalDevices = ref<number>(0)
  const totalStorage = ref<number>(0)
  const dashboardFetched = ref<boolean>(false)
  const _initialLoadPromise = ref(createDeferredPromise<boolean>())

  const totalDownload = ref<number>(0)

  const logout = async () => {
    const supabase = useSupabase()
    const config = getLocalConfig()
    const { error } = await supabase.auth.signOut()
    if (error)
      throw error

    auth.value = undefined
    user.value = undefined
    isAdmin.value = false
    reset(config.supaHost)
    clearSpoof()
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
    try {
      const { start, end } = normalizeDashboardDateRange(rangeStart, rangeEnd)
      const dashboardRes = await getAllDashboard(currentOrgId, start, end)
      dashboard.value = dashboardRes.global
      dashboardByapp.value = dashboardRes.byApp

      const monthDay = calculateMonthDay(start)

      totalDevices.value = dashboard.value[monthDay]?.mau ?? 0
      totalDownload.value = dashboard.value[monthDay]?.get ?? 0
      totalStorage.value = await getTotalStorage()
      totalStats.value = getTotalStats()
      bestPlan.value = await findBestPlan(totalStats.value)
      dashboardFetched.value = true
      _initialLoadPromise.value.resolve(true)
    }
    catch (error) {
      _initialLoadPromise.value.reject(error)
      throw error
    }
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
    statsTime,
    plans,
    isAdmin,
    totalStorage,
    totalStats,
    bestPlan,
    totalDevices,
    totalDownload,
    dashboardFetched,
    updateDashboard,
    filterDashboard,
    dashboard,
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

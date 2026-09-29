import type { DateRangePreset, DateRangeValue } from '~/services/dateRange'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DEFAULT_DATE_RANGE_PRESET,
  getDateRangeForPreset,
  parseDateRangeQuery,
  serializeDateRangeQuery,
} from '~/services/dateRange'

const OBSERVE_DATE_RANGE_DEFAULT = DEFAULT_DATE_RANGE_PRESET

export function useObserveDateRangeQuery() {
  const route = useRoute()
  const router = useRouter()

  const rangeMode = ref<DateRangePreset>(OBSERVE_DATE_RANGE_DEFAULT)
  const preciseDates = ref<[Date, Date] | null>(null)

  function syncFromQuery() {
    const parsed = parseDateRangeQuery(route.query)
    if (parsed?.mode === 'custom') {
      rangeMode.value = 'custom'
      preciseDates.value = [parsed.start, parsed.end]
      return
    }
    if (parsed?.mode) {
      rangeMode.value = parsed.mode
      const range = getDateRangeForPreset(parsed.mode)
      preciseDates.value = [range.start, range.end]
      return
    }
    const initial = getDateRangeForPreset(OBSERVE_DATE_RANGE_DEFAULT)
    rangeMode.value = OBSERVE_DATE_RANGE_DEFAULT
    preciseDates.value = [initial.start, initial.end]
  }

  function ensureQueryDefaults() {
    if (parseDateRangeQuery(route.query))
      return
    const initial = getDateRangeForPreset(OBSERVE_DATE_RANGE_DEFAULT)
    preciseDates.value = [initial.start, initial.end]
    rangeMode.value = OBSERVE_DATE_RANGE_DEFAULT
    const serialized = serializeDateRangeQuery(OBSERVE_DATE_RANGE_DEFAULT)
    void router.replace({
      query: {
        ...route.query,
        range: serialized.range,
      },
    })
  }

  syncFromQuery()
  ensureQueryDefaults()

  watch(() => [route.query.range, route.query.start, route.query.end] as const, () => {
    syncFromQuery()
  })

  const rangeValue = computed<DateRangeValue>(() => {
    const dates = preciseDates.value
    if (!dates)
      return getDateRangeForPreset(OBSERVE_DATE_RANGE_DEFAULT)
    return { start: dates[0], end: dates[1] }
  })

  function applyRange(payload: { start: Date, end: Date, mode: DateRangePreset }) {
    preciseDates.value = [payload.start, payload.end]
    rangeMode.value = payload.mode
    const serialized = serializeDateRangeQuery(payload.mode, { start: payload.start, end: payload.end })
    const query = { ...route.query }
    query.range = serialized.range
    if (serialized.start && serialized.end) {
      query.start = serialized.start
      query.end = serialized.end
    }
    else {
      delete query.start
      delete query.end
    }
    delete query.days
    void router.replace({ query })
  }

  return {
    rangeMode,
    preciseDates,
    rangeValue,
    applyRange,
    defaultPreset: OBSERVE_DATE_RANGE_DEFAULT,
  }
}

import type { PeriodDayOption } from '~/utils/periodDays'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DEFAULT_PERIOD_DAYS, parsePeriodDays } from '~/utils/periodDays'

export type { PeriodDayOption } from '~/utils/periodDays'
export { DEFAULT_PERIOD_DAYS, parsePeriodDays, PERIOD_DAY_OPTIONS } from '~/utils/periodDays'

export function usePeriodDaysQuery(defaultDays: PeriodDayOption = DEFAULT_PERIOD_DAYS) {
  const route = useRoute()
  const router = useRouter()

  const days = computed<PeriodDayOption>({
    get() {
      return parsePeriodDays(route.query.days) ?? defaultDays
    },
    set(value) {
      if (String(route.query.days ?? '') === String(value))
        return
      void router.replace({ query: { ...route.query, days: String(value) } })
    },
  })

  return { days }
}

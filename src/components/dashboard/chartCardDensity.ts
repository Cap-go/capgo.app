import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'

// Pages that must fit several chart cards above the fold provide a compact
// density; every ChartCard below them shrinks its height and type scale.
const chartCardCompactKey: InjectionKey<Ref<boolean>> = Symbol('chartCardCompact')

export function provideChartCardCompact(compact: Ref<boolean> = ref(true)) {
  provide(chartCardCompactKey, compact)
}

export function useChartCardCompact() {
  return inject(chartCardCompactKey, ref(false))
}

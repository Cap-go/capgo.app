import type { InjectionKey, Ref } from 'vue'
import { computed, inject, provide, ref } from 'vue'

export type ChartCardDensity = 'normal' | 'compact' | 'dense'

// Pages that must fit several chart cards above the fold provide a smaller
// density; every ChartCard below them shrinks its height and type scale.
const chartCardDensityKey: InjectionKey<Ref<ChartCardDensity>> = Symbol('chartCardDensity')

export function provideChartCardCompact(density: ChartCardDensity = 'compact') {
  provide(chartCardDensityKey, ref(density))
}

export function useChartCardDensity() {
  return inject(chartCardDensityKey, ref<ChartCardDensity>('normal'))
}

export function useChartCardCompact() {
  const density = useChartCardDensity()
  return computed(() => density.value !== 'normal')
}

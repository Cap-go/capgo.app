import type { Bar as ChartBar, Line as ChartLine } from 'vue-chartjs'
import { defineAsyncComponent } from 'vue'

// Chart.js is the largest dependency of the dashboard pages. Loading it on demand lets
// the cards, numbers and text render first; the canvas appears once the chunk arrives.
const loadCharts = () => import('~/services/chartjs')

export const Bar = defineAsyncComponent(() => loadCharts().then(module => module.Bar)) as unknown as typeof ChartBar
export const Line = defineAsyncComponent(() => loadCharts().then(module => module.Line)) as unknown as typeof ChartLine

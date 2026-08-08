import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'

let registered = false

/** Register Chart.js controllers once for dashboard bar/line charts. */
export function registerDashboardCharts() {
  if (registered)
    return
  Chart.register(
    Tooltip,
    Legend,
    BarController,
    BarElement,
    LineController,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Filler,
  )
  registered = true
}

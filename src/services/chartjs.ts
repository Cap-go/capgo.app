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

// Every bar and line chart in the console uses these pieces. Load this module only through
// ~/components/dashboard/lazyCharts so Chart.js stays out of the page chunks.
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

export { Bar, Line } from 'vue-chartjs'

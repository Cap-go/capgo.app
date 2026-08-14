import type { ChartData, ChartOptions, TooltipItem } from 'chart.js'
import { formatLocalDate } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

export interface AdminDailyConversionPoint {
  date: string
  started: number
  converted: number
  conversion_percent: number | null
}

export function buildAdminDailyConversionChartData(
  points: readonly AdminDailyConversionPoint[],
  label: string,
  color: string,
): ChartData<'bar', Array<number | null>> {
  return {
    labels: points.map(point => formatLocalDate(point.date) || point.date),
    datasets: [{
      label,
      data: points.map(point => point.conversion_percent),
      backgroundColor: color,
      borderRadius: 6,
      borderSkipped: false,
      maxBarThickness: 44,
    }],
  }
}

export function buildAdminDailyConversionChartOptions(
  points: readonly AdminDailyConversionPoint[],
  isDark: boolean,
  attemptsLabel: string,
): ChartOptions<'bar'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'x',
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
        titleColor: isDark ? '#f3f4f6' : '#1f2937',
        bodyColor: isDark ? '#d1d5db' : '#4b5563',
        borderColor: isDark ? '#374151' : '#e5e7eb',
        borderWidth: 1,
        padding: 12,
        callbacks: {
          label: (context: TooltipItem<'bar'>) => {
            const point = points[context.dataIndex]
            if (!point || point.conversion_percent === null)
              return ''

            const percent = formatNumberValue(point.conversion_percent, { maximumFractionDigits: 1 })
            return `${percent}% · ${formatNumberValue(point.converted)} / ${formatNumberValue(point.started)} ${attemptsLabel}`
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: isDark ? '#9ca3af' : '#6b7280' },
      },
      y: {
        beginAtZero: true,
        min: 0,
        max: 100,
        grid: { color: isDark ? 'rgba(75, 85, 99, 0.3)' : 'rgba(229, 231, 235, 0.8)' },
        ticks: {
          color: isDark ? '#9ca3af' : '#6b7280',
          callback: value => `${value}%`,
        },
      },
    },
  }
}

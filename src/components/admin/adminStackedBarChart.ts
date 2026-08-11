import type { ChartData, ChartOptions } from 'chart.js'
import { formatNumberValue } from '~/services/formatLocale'

export interface AdminStackedBarDataset {
  label: string
  data: number[]
  color: string
}

export function buildAdminStackedBarChartData(
  labels: string[],
  series: AdminStackedBarDataset[],
): ChartData<'bar'> {
  return {
    labels,
    datasets: series.map(item => ({
      label: item.label,
      data: item.data,
      backgroundColor: item.color,
      borderColor: item.color,
      borderWidth: 0,
      borderRadius: 4,
      borderSkipped: false,
    })),
  }
}

export function applyAdminStackedBarAccessibleBorders(
  data: ChartData<'bar'>,
  accessibleBorders: boolean,
  isDark: boolean,
): ChartData<'bar'> {
  if (!accessibleBorders)
    return data

  return {
    ...data,
    datasets: data.datasets.map(dataset => ({
      ...dataset,
      borderColor: isDark ? '#f8fafc' : '#0f172a',
      borderWidth: 1,
    })),
  }
}

export function formatAdminStackedBarTooltip(label: string, value: number, total: number) {
  const percentage = total > 0 ? (value / total) * 100 : 0
  return `${label}: ${formatNumberValue(value)} (${formatNumberValue(percentage, { maximumFractionDigits: 1 })}%)`
}

export function buildAdminStackedBarChartOptions(isDark: boolean): ChartOptions<'bar'> {
  const textColor = isDark ? '#d1d5db' : '#4b5563'
  const mutedTextColor = isDark ? '#9ca3af' : '#6b7280'

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        left: 0,
        right: 0,
        top: 10,
        bottom: 10,
      },
    },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: textColor,
          boxHeight: 10,
          boxWidth: 10,
          font: {
            size: 12,
            weight: 500,
          },
          padding: 18,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
        titleColor: isDark ? '#f3f4f6' : '#1f2937',
        bodyColor: textColor,
        borderColor: isDark ? '#374151' : '#e5e7eb',
        borderWidth: 1,
        padding: 12,
        displayColors: true,
        callbacks: {
          label: (context) => {
            const value = Number(context.parsed.y ?? 0)
            const total = context.chart.data.datasets.reduce((sum, dataset) => {
              return sum + Number(dataset.data[context.dataIndex] ?? 0)
            }, 0)
            return formatAdminStackedBarTooltip(context.dataset.label || '', value, total)
          },
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        grid: {
          display: false,
        },
        ticks: {
          color: mutedTextColor,
          maxRotation: 0,
          minRotation: 0,
          autoSkip: true,
          maxTicksLimit: 10,
        },
      },
      y: {
        stacked: true,
        beginAtZero: true,
        grid: {
          color: isDark ? 'rgba(75, 85, 99, 0.3)' : 'rgba(229, 231, 235, 0.8)',
        },
        ticks: {
          color: mutedTextColor,
          precision: 0,
          callback: value => typeof value === 'number' ? formatNumberValue(value) : value,
        },
      },
    },
  }
}

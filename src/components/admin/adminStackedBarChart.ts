import type { ChartData, Chart as ChartJs, ChartOptions, LegendItem } from 'chart.js'
import { formatNumberValue } from '~/services/formatLocale'

export interface AdminStackedBarDataset {
  label: string
  data: number[]
  color: string
  stack?: string
  stackLabel?: string
}

export type AdminStackedBarChartDataset = ChartData<'bar'>['datasets'][number] & { stackLabel?: string }
export type AdminStackedBarChartData = Omit<ChartData<'bar'>, 'datasets'> & { datasets: AdminStackedBarChartDataset[] }
type AdminStackedBarCompatibleDataset = Pick<
  ChartData['datasets'][number],
  'backgroundColor' | 'borderColor' | 'borderWidth' | 'data' | 'label'
> & { stack?: string, stackLabel?: string }

export function buildAdminStackedBarChartData(
  labels: string[],
  series: AdminStackedBarDataset[],
): AdminStackedBarChartData {
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
      stack: item.stack,
      stackLabel: item.stackLabel,
    })),
  }
}

export function applyAdminStackedBarAccessibleBorders(
  data: AdminStackedBarChartData,
  accessibleBorders: boolean,
  isDark: boolean,
): AdminStackedBarChartData {
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

interface AdminLegendDataChart {
  data: { datasets: AdminStackedBarCompatibleDataset[] }
  isDatasetVisible: ChartJs['isDatasetVisible']
}
type AdminLegendToggleChart = AdminLegendDataChart & Pick<ChartJs, 'setDatasetVisibility' | 'update'>

function datasetValue(dataset: AdminStackedBarCompatibleDataset, dataIndex: number): number {
  const value = dataset.data[dataIndex]
  return typeof value === 'number' ? value : 0
}

function datasetTotal(dataset: AdminStackedBarCompatibleDataset): number {
  let total = 0
  for (let dataIndex = 0; dataIndex < dataset.data.length; dataIndex++)
    total += datasetValue(dataset, dataIndex)
  return total
}

export function getAdminStackedBarTooltipTotal(
  datasets: readonly AdminStackedBarCompatibleDataset[],
  datasetIndex: number,
  dataIndex: number,
): number {
  const activeStack = datasets[datasetIndex]?.stack
  return datasets.reduce((sum, dataset) => {
    if (activeStack !== undefined && dataset.stack !== activeStack)
      return sum
    return sum + datasetValue(dataset, dataIndex)
  }, 0)
}

export function buildAdminStackedBarLegendItems(
  chart: AdminLegendDataChart,
  fontColor: LegendItem['fontColor'] = '#4b5563',
): LegendItem[] {
  const seen = new Set<string>()
  return chart.data.datasets.flatMap((dataset, datasetIndex) => {
    const label = dataset.label ?? ''
    if (!label || seen.has(label) || datasetTotal(dataset) === 0)
      return []

    const matchingDatasets = chart.data.datasets
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.label === label)

    seen.add(label)
    return [{
      text: label,
      fillStyle: typeof dataset.backgroundColor === 'string' ? dataset.backgroundColor : '#94a3b8',
      fontColor,
      strokeStyle: typeof dataset.borderColor === 'string' ? dataset.borderColor : '#94a3b8',
      lineWidth: typeof dataset.borderWidth === 'number' ? dataset.borderWidth : 0,
      hidden: matchingDatasets.every(({ index }) => !chart.isDatasetVisible(index)),
      datasetIndex,
      pointStyle: 'circle' as const,
    }]
  })
}

export function toggleAdminStackedBarLegendGroup(chart: AdminLegendToggleChart, label: string): void {
  const indexes = chart.data.datasets
    .map((dataset, index) => ({ dataset, index }))
    .filter(({ dataset }) => dataset.label === label)
    .map(({ index }) => index)
  const show = indexes.every(index => !chart.isDatasetVisible(index))
  for (const index of indexes)
    chart.setDatasetVisibility(index, show)
  chart.update()
}

export function buildAdminStackedBarChartOptions(
  isDark: boolean,
  groupedStacks = false,
): ChartOptions<'bar'> {
  const textColor = isDark ? '#d1d5db' : '#4b5563'
  const mutedTextColor = isDark ? '#9ca3af' : '#6b7280'

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: groupedStacks ? 'nearest' : 'index',
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
          ...(groupedStacks ? { generateLabels: chart => buildAdminStackedBarLegendItems(chart, textColor) } : {}),
        },
        ...(groupedStacks
          ? { onClick: (_event, item, legend) => toggleAdminStackedBarLegendGroup(legend.chart, item.text) }
          : {}),
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
            const total = getAdminStackedBarTooltipTotal(
              context.chart.data.datasets,
              context.datasetIndex,
              context.dataIndex,
            )
            const dataset: AdminStackedBarCompatibleDataset = context.dataset
            const label = dataset.stackLabel
              ? `${dataset.stackLabel} · ${dataset.label ?? ''}`
              : dataset.label ?? ''
            return formatAdminStackedBarTooltip(label, value, total)
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

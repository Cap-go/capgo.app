import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(utc)

/** Inclusive UTC day labels from `from` through `to` as YYYY-MM-DD. */
export function generateDateLabels(from: Date, to: Date): string[] {
  const start = dayjs(from).utc().startOf('day')
  const end = dayjs(to).utc().startOf('day')

  if (start.isAfter(end))
    return []

  const labels: string[] = []
  let cursor = start
  while (cursor.isBefore(end) || cursor.isSame(end)) {
    labels.push(cursor.format('YYYY-MM-DD'))
    cursor = cursor.add(1, 'day')
  }

  return labels
}

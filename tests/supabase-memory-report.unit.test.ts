import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { memoryReport } from '../scripts/ops/supabase_memory_report.ts'

const GIB = 1024 ** 3
const captureTime = '2026-10-29T00:00:00.000Z'
const execute = promisify(execFile)

function metrics(committed = 10 * GIB) {
  return [
    '# HELP node_memory_MemTotal_bytes Physical memory',
    `node_memory_MemTotal_bytes{service_type="db",supabase_project_ref="example"} ${16 * GIB}`,
    `node_memory_MemAvailable_bytes{service_type="db"} ${9 * GIB}`,
    `node_memory_Committed_AS_bytes{service_type="db"} ${committed}`,
    `node_memory_CommitLimit_bytes{service_type="db"} ${9 * GIB}`,
    `node_memory_SwapTotal_bytes{service_type="db"} ${GIB}`,
    `node_memory_SwapFree_bytes{service_type="db"} ${GIB / 2}`,
    'node_vmstat_oom_kill{service_type="db"} 0',
    'node_vmstat_pswpin{service_type="db"} 12',
    'node_vmstat_pswpout{service_type="db"} 20',
    'node_boot_time_seconds{service_type="db"} 1793203200',
    // A different service and arbitrary labels must never be copied into the output.
    'node_memory_MemTotal_bytes{service_type="gotrue",private_label="do-not-publish"} 1',
    'unrelated_metric{service_type="db",private_label="do-not-publish"} 999',
  ].join('\n')
}

describe('Supabase memory commitment report', () => {
  it.concurrent('reports commitment separately from available memory and the kernel limit', () => {
    const report = memoryReport(metrics(), captureTime)
    expect(report).toEqual({
      capturedAt: captureTime,
      physicalBytes: 16 * GIB,
      availableBytes: 9 * GIB,
      committedBytes: 10 * GIB,
      kernelCommitLimitBytes: 9 * GIB,
      thresholdsBytes: { warning: 9 * GIB, problematic: 13.8 * GIB, severe: 15.4 * GIB },
      commitmentZone: 'warning',
      swapUsedBytes: GIB / 2,
      oomKillsSinceBoot: 0,
      swapInPagesSinceBoot: 12,
      swapOutPagesSinceBoot: 20,
      hostBootTimeSeconds: 1793203200,
    })
    expect(JSON.stringify(report)).not.toMatch(/example|private_label|do-not-publish/)
  })

  it.concurrent.each([
    [8.99, 'below-warning'],
    [9, 'warning'],
    [13.79, 'warning'],
    [13.8, 'problematic'],
    [15.39, 'problematic'],
    [15.4, 'severe'],
    [22, 'severe'],
  ])('classifies %.2f GiB committed as %s', (committedGiB, zone) => {
    expect(memoryReport(metrics(committedGiB * GIB)).commitmentZone).toBe(zone)
  })

  it.concurrent('does not interpret an absent OOM counter as zero OOM kills', () => {
    const report = memoryReport(metrics().split('\n').filter(line => !line.startsWith('node_vmstat_')).join('\n'))
    expect(report.oomKillsSinceBoot).toBeNull()
    expect(report.swapInPagesSinceBoot).toBeNull()
    expect(report.swapOutPagesSinceBoot).toBeNull()
  })

  it.concurrent('leaves an offline capture time unknown unless supplied', () => {
    expect(memoryReport(metrics()).capturedAt).toBeNull()
  })

  it.concurrent.each([
    ['node_memory_MemAvailable_bytes', 17 * GIB, 'Invalid physical or available memory'],
    ['node_memory_SwapFree_bytes', 2 * GIB, 'Invalid free swap'],
  ])('rejects inconsistent %s', (name, value, message) => {
    const snapshot = metrics().split('\n').map(line => line.startsWith(`${name}{`) ? `${name}{service_type="db"} ${value}` : line).join('\n')
    expect(() => memoryReport(snapshot)).toThrow(message)
  })

  it.concurrent('rejects incomplete snapshots rather than reporting a healthy database', () => {
    expect(() => memoryReport('node_memory_MemTotal_bytes{service_type="db"} 100'))
      .toThrow('Missing database-host metric: node_memory_MemAvailable_bytes')
  })

  it.concurrent.each(['NaN', '+Inf', '-1'])('rejects an invalid required gauge: %s', (value) => {
    const snapshot = metrics().replace(`} ${16 * GIB}`, `} ${value}`)
    expect(() => memoryReport(snapshot)).toThrow('Invalid value for node_memory_MemTotal_bytes')
  })

  it.concurrent('rejects ambiguous snapshots from multiple database hosts', () => {
    const snapshot = `${metrics()}\nnode_memory_MemTotal_bytes{service_type="db",supabase_identifier="another-host"} 123`
    expect(() => memoryReport(snapshot)).toThrow('Multiple database hosts')
  })

  it.concurrent('accepts scientific notation and a Prometheus sample timestamp', () => {
    const snapshot = metrics().replace(`} ${16 * GIB}`, '} 1.7179869184e+10 1793232000000')
    expect(memoryReport(snapshot).physicalBytes).toBe(16 * GIB)
  })

  it.concurrent('requires both swap gauges before reporting swap usage', () => {
    const snapshot = metrics().split('\n').filter(line => !line.startsWith('node_memory_SwapFree_bytes')).join('\n')
    expect(memoryReport(snapshot).swapUsedBytes).toBeNull()
  })

  it.concurrent('runs the offline CLI without credentials and emits only the report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capgo-memory-report-'))
    try {
      const path = join(directory, 'metrics.prom')
      await writeFile(path, metrics())
      const { stdout, stderr } = await execute('bun', ['scripts/ops/supabase_memory_report.ts', '--metrics-file', path], {
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: '' },
      })
      const report = JSON.parse(stdout)
      expect(report.capturedAt).toBeNull()
      expect(report.commitmentZone).toBe('warning')
      expect(report.availableBytes).toBe(9 * GIB)
      expect(stdout).not.toMatch(/do-not-publish|private_label|example/)
      expect(stderr).toBe('')
      const dated = await execute('bun', [
        'scripts/ops/supabase_memory_report.ts', '--metrics-file', path, '--captured-at', captureTime,
      ])
      expect(JSON.parse(dated.stdout).capturedAt).toBe(captureTime)
      await expect(execute('bun', [
        'scripts/ops/supabase_memory_report.ts', '--metrics-file', path, '--captured-at', '2026-10-29',
      ])).rejects.toMatchObject({
        code: 1,
        stderr: '--captured-at must be an ISO timestamp with a timezone\n',
      })
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

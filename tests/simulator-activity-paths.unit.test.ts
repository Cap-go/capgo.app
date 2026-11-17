import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_IDLE_TIMEOUT_MINUTES } from '../supabase/functions/_backend/public/build/concurrency.ts'
import { simulatorActivityBumpSql } from '../supabase/functions/_backend/public/build/simulator.ts'

const simulatorPath = join(dirname(fileURLToPath(import.meta.url)), '../supabase/functions/_backend/public/build/simulator.ts')

function extractExportedFunction(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`)
  if (start < 0)
    throw new Error(`missing ${name}`)
  const next = source.indexOf('\nexport async function ', start + 1)
  return next < 0 ? source.slice(start) : source.slice(start, next)
}

describe('simulator activity bump paths', () => {
  const source = readFileSync(simulatorPath, 'utf8')

  it('keeps the bump SQL aligned with the idle timeout constant', () => {
    expect(simulatorActivityBumpSql()).toContain(`make_interval(mins => ${SIMULATOR_IDLE_TIMEOUT_MINUTES})`)
    expect(simulatorActivityBumpSql()).toContain('SET last_activity_at = now()')
  })

  it('does not count status reads as activity', () => {
    const readBlock = extractExportedFunction(source, 'readSimulator')
    expect(readBlock).toMatch(/bump:\s*false/)
    expect(readBlock).not.toContain('last_activity_at = now()')
  })

  it('bumps activity on commands', () => {
    const commandBlock = extractExportedFunction(source, 'commandSimulator')
    expect(commandBlock).toContain('touchSimulatorActivity')
    expect(commandBlock).not.toMatch(/bump:\s*false/)
  })

  it('bumps activity after installing a saved build', () => {
    expect(source).toMatch(/async function installSavedIpa[\s\S]*?touchSimulatorActivity/)
  })

  it('bumps activity through the console heartbeat endpoint', () => {
    const pingBlock = extractExportedFunction(source, 'pingSimulatorActivity')
    expect(pingBlock).toMatch(/bump:\s*true/)
  })
})
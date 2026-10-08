import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const auditLogTableSource = readFileSync(new URL('../src/components/tables/AuditLogTable.vue', import.meta.url), 'utf8')

function columnClass(key: string) {
  const match = auditLogTableSource.match(new RegExp(`key: '${key}',[\\s\\S]*?class: '([^']*)'`))
  return match?.[1] ?? ''
}

describe('audit log table columns', () => {
  it.concurrent('gives the actor column room for emails and API key names', () => {
    const actorClass = columnClass('actor')
    expect(actorClass).not.toContain('max-w-8')
    expect(actorClass).toContain('min-w-48')
  })

  it.concurrent('shows the full date on desktop', () => {
    expect(columnClass('created_at')).toContain('md:max-w-none')
  })

  it.concurrent('exposes truncated actor and changed fields through the cell title', () => {
    expect(auditLogTableSource).toContain(':title="getCellTitle(elem, col)"')
    const titleHelper = auditLogTableSource.slice(
      auditLogTableSource.indexOf('function getCellTitle('),
      auditLogTableSource.indexOf('function displayValueKey('),
    )
    expect(titleHelper).toContain('getActorDisplay(elem)')
    expect(titleHelper).toContain('elem.changed_fields.join(\', \')')
  })
})

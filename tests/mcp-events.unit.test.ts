import { describe, expect, it } from 'vitest'
import {
  mapAuditLogToMcpEvent,
  MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ORG,
  MCP_EVENT_DEFAULT_TTL_MS,
} from '../supabase/functions/_backend/utils/mcp_events.ts'
import type { AuditLogData } from '../supabase/functions/_backend/utils/webhook.ts'

describe('mcp events mapping', () => {
  it('maps bundle.uploaded from app_versions insert', () => {
    const audit: AuditLogData = {
      audit_log_id: 1,
      table_name: 'app_versions',
      operation: 'INSERT',
      org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      record_id: '99',
      old_record: null,
      new_record: { app_id: 'com.demo.app', name: '1.0.0', id: 99 },
      changed_fields: null,
      user_id: null,
      created_at: new Date().toISOString(),
    }
    expect(mapAuditLogToMcpEvent(audit)).toBe('bundle.uploaded')
  })

  it('skips bundle.deployed when channel version unchanged', () => {
    const audit: AuditLogData = {
      audit_log_id: 2,
      table_name: 'channels',
      operation: 'UPDATE',
      org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      record_id: '7',
      old_record: { version: 10, name: 'production', app_id: 'com.demo.app' },
      new_record: { version: 10, name: 'production', app_id: 'com.demo.app' },
      changed_fields: ['updated_at'],
      user_id: null,
      created_at: new Date().toISOString(),
    }
    expect(mapAuditLogToMcpEvent(audit)).toBeNull()
  })

  it('maps bundle.deployed when version changes', () => {
    const audit: AuditLogData = {
      audit_log_id: 3,
      table_name: 'channels',
      operation: 'UPDATE',
      org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      record_id: '7',
      old_record: { version: 10, name: 'production', app_id: 'com.demo.app' },
      new_record: { version: 11, name: 'production', app_id: 'com.demo.app' },
      changed_fields: ['version'],
      user_id: null,
      created_at: new Date().toISOString(),
    }
    expect(mapAuditLogToMcpEvent(audit)).toBe('bundle.deployed')
  })

  it('exposes subscription defaults', () => {
    expect(MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ORG).toBe(25)
    expect(MCP_EVENT_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000)
    expect(MCP_EVENT_DEFAULT_TTL_MS).toBeGreaterThan(60_000)
  })
})

// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onMounted, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import ChannelTable from '../src/components/tables/ChannelTable.vue'
import { useDialogV2Store } from '../src/stores/dialogv2'

const state = vi.hoisted(() => ({
  rows: [] as any[],
  failed: false,
  canCreate: true,
  createPermissions: {} as Record<string, Promise<boolean>>,
  inserts: [] as any[],
  delayedApp: '',
  delayedResponse: null as Promise<unknown> | null,
  permissionChecks: [] as Array<{ permission: string, scope: { appId?: string, channelId?: number } }>,
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: 'preview-user' } }) }))
vi.mock('~/stores/organization', async () => {
  const { defineStore } = await import('pinia')
  const { ref } = await import('vue')
  return { useOrganizationStore: defineStore('channel-test-org', () => ({ currentOrganization: ref({ gid: 'preview-org' }) })) }
})
vi.mock('~/services/permissions', () => ({
  checkPermissions: async (permission: string, scope: { appId?: string, channelId?: number }) => {
    state.permissionChecks.push({ permission, scope })
    return permission === 'app.create_channel' ? state.createPermissions[scope.appId!] ?? state.canCreate : true
  },
}))
vi.mock('~/components/dashboard/ChannelIntroduction.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    props: ['canCreate'],
    emits: ['create'],
    setup: (props, { emit }) => () => h('section', { 'data-test': 'channel-introduction' }, [
      props.canCreate ? h('button', { 'data-test': 'create-channel', 'onClick': () => emit('create') }, 'Create') : null,
    ]),
  }) }
})
vi.mock('~/services/console', () => ({
  useConsole: () => ({
    from(table: string) {
      let appId = ''
      let search = ''
      let insert: any[] | undefined
      const query: any = {
        select: () => query,
        eq: (column: string, value: string) => { if (column === 'app_id') appId = value; return query },
        order: () => query,
        range: () => query,
        like: (_column: string, value: string) => { search = value.slice(1, -1); return query },
        insert: (rows: any[]) => { insert = rows; return query },
        maybeSingle: async () => ({ data: { default_upload_channel: null } }),
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          if (table === 'channels' && appId === state.delayedApp && state.delayedResponse)
            return state.delayedResponse.then(resolve, reject)
          if (insert) {
            state.inserts.push(...insert)
            state.rows.push(...insert.map((row, index) => ({ ...row, id: index + 1 })))
          }
          const rows = state.rows.filter(row => !search || row.name.includes(search))
          return Promise.resolve(table === 'channels'
            ? { data: state.failed ? null : rows, count: state.failed ? null : rows.length }
            : { data: [] }).then(resolve, reject)
        },
      }
      return query
    },
  }),
}))

let app: App | undefined
let container: HTMLElement
let tableEmit: (event: string, value?: unknown) => void
let dialog: ReturnType<typeof useDialogV2Store>
let currentAppId = ref('')

async function settle() {
  for (let i = 0; i < 12; i++)
    await nextTick()
}

async function mountTable(appId = 'com.example.channels') {
  container = document.createElement('div')
  document.body.appendChild(container)
  const target = document.createElement('div')
  target.id = 'dialog-v2-content'
  document.body.appendChild(target)
  const pinia = createPinia()
  currentAppId = ref(appId)
  app = createApp({ setup: () => () => h(ChannelTable, { appId: currentAppId.value }) })
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
  app.component('DataTable', defineComponent({
    props: ['isLoading', 'elementList', 'showAdd'],
    emits: ['reload', 'update:search', 'add'],
    setup(props, { emit }) {
      tableEmit = emit
      onMounted(() => emit('reload'))
      return () => h('div', { 'data-test': 'channel-table', 'data-loading': props.isLoading, 'data-show-add': props.showAdd }, props.elementList.map((row: any) => row.name).join(', '))
    },
  }))
  app.mount(container)
  dialog = useDialogV2Store(pinia)
  await settle()
}

beforeEach(() => {
  state.rows = []
  state.inserts = []
  state.failed = false
  state.canCreate = true
  state.createPermissions = {}
  state.delayedApp = ''
  state.delayedResponse = null
  state.permissionChecks = []
})
afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
})

describe('Channels page empty state', () => {
  it('shows the introduction after an empty read without automatically opening creation or writing data', async () => {
    await mountTable()
    expect(container.querySelector('[data-test="channel-introduction"]')).not.toBeNull()
    expect(dialog.showDialog).toBe(false)
    expect(state.inserts).toEqual([])
  })

  it('keeps the regular table when channels exist', async () => {
    state.rows = [{ id: 1, name: 'production' }]
    await mountTable()
    expect(container.querySelector('[data-test="channel-introduction"]')).toBeNull()
    expect(container.textContent).toContain('production')
  })

  it('checks delete access with both the requested app and each returned channel', async () => {
    state.rows = [{ id: 17, name: 'production' }, { id: 23, name: 'beta' }]
    await mountTable()
    expect(state.permissionChecks.filter(check => check.permission === 'channel.delete')).toEqual([
      { permission: 'channel.delete', scope: { appId: 'com.example.channels', channelId: 17 } },
      { permission: 'channel.delete', scope: { appId: 'com.example.channels', channelId: 23 } },
    ])
  })

  it('does not mistake an empty search result for an app without channels', async () => {
    state.rows = [{ id: 1, name: 'production' }]
    await mountTable()
    tableEmit('update:search', 'missing')
    await nextTick()
    tableEmit('reload')
    await settle()
    expect(container.querySelector('[data-test="channel-introduction"]')).toBeNull()
    expect(dialog.showDialog).toBe(false)
  })

  it('does not treat a failed read as an empty app and ends the loading state', async () => {
    state.failed = true
    await mountTable()
    expect(container.querySelector('[data-test="channel-introduction"]')).toBeNull()
    expect(container.querySelector('[data-test="channel-table"]')?.getAttribute('data-loading')).toBe('false')
    expect(dialog.showDialog).toBe(false)
  })

  it('keeps a filtered zero count from showing the introduction before clearing search reloads', async () => {
    state.rows = [{ id: 1, name: 'production' }]
    await mountTable()
    tableEmit('update:search', 'missing')
    await nextTick()
    tableEmit('reload')
    await settle()
    tableEmit('update:search', '')
    await settle()
    expect(container.querySelector('[data-test="channel-introduction"]')).toBeNull()
    tableEmit('reload')
    await settle()
    expect(container.textContent).toContain('production')
  })

  it('ignores an obsolete empty response after switching to a populated app', async () => {
    let finishOldRequest!: (response: unknown) => void
    state.delayedApp = 'com.example.empty'
    state.delayedResponse = new Promise(resolve => finishOldRequest = resolve)
    await mountTable(state.delayedApp)
    state.rows = [{ id: 1, name: 'production' }]
    currentAppId.value = 'com.example.populated'
    await settle()
    expect(container.textContent).toContain('production')
    finishOldRequest({ data: [], count: 0 })
    await settle()
    expect(container.querySelector('[data-test="channel-introduction"]')).toBeNull()
    expect(container.textContent).toContain('production')
    expect(container.querySelector('[data-test="channel-table"]')?.getAttribute('data-loading')).toBe('false')
  })

  it('lets readers view the introduction without offering channel creation', async () => {
    state.canCreate = false
    await mountTable()
    expect(container.querySelector('[data-test="channel-introduction"]')).not.toBeNull()
    expect(container.querySelector('[data-test="create-channel"]')).toBeNull()
    expect(dialog.showDialog).toBe(false)
  })

  it.each([false, true])('hides creation while the current app permission is pending (populated: %s)', async (populated) => {
    if (populated)
      state.rows = [{ id: 1, name: 'production' }]
    await mountTable()
    let finishPermission!: (allowed: boolean) => void
    state.createPermissions['com.example.next'] = new Promise(resolve => finishPermission = resolve)
    currentAppId.value = 'com.example.next'
    await settle()
    expect(container.querySelector('[data-test="create-channel"]')).toBeNull()
    expect(container.querySelector('[data-test="channel-table"]')?.getAttribute('data-show-add')).toBe('false')
    tableEmit('add')
    await settle()
    expect(dialog.showDialog).toBe(false)
    finishPermission(true)
    await settle()
    expect(container.querySelector('[data-test="channel-table"]')?.getAttribute('data-show-add')).toBe('true')
  })

  it.each([false, true])('denies creation after the current app permission rejects (populated: %s)', async (populated) => {
    if (populated)
      state.rows = [{ id: 1, name: 'production' }]
    await mountTable()
    let rejectPermission!: (error: Error) => void
    state.createPermissions['com.example.next'] = new Promise((_resolve, reject) => rejectPermission = reject)
    currentAppId.value = 'com.example.next'
    await settle()
    rejectPermission(new Error('permission lookup unavailable'))
    await settle()
    expect(container.querySelector('[data-test="create-channel"]')).toBeNull()
    expect(container.querySelector('[data-test="channel-table"]')?.getAttribute('data-show-add')).toBe('false')
    tableEmit('add')
    await settle()
    expect(dialog.showDialog).toBe(false)
    expect(state.inserts).toEqual([])
  })

  it('ignores an obsolete allow result after a new app denies creation', async () => {
    let finishOldPermission!: (allowed: boolean) => void
    state.createPermissions['com.example.channels'] = new Promise(resolve => finishOldPermission = resolve)
    await mountTable()
    state.canCreate = false
    currentAppId.value = 'com.example.next'
    await settle()
    finishOldPermission(true)
    await settle()
    expect(container.querySelector('[data-test="create-channel"]')).toBeNull()
    expect(container.querySelector('[data-test="channel-table"]')?.getAttribute('data-show-add')).toBe('false')
  })

  it('opens the existing creation dialog only after the explicit action', async () => {
    await mountTable()
    container.querySelector<HTMLButtonElement>('[data-test="create-channel"]')!.click()
    await settle()
    expect(dialog.showDialog).toBe(true)
    expect(dialog.dialogOptions.title).toBe('Create channel')
    expect(state.inserts).toEqual([])
  })

  it('replaces the introduction with the channel table after creating a channel', async () => {
    await mountTable()
    container.querySelector<HTMLButtonElement>('[data-test="create-channel"]')!.click()
    await settle()
    const input = document.querySelector<HTMLInputElement>('#dialog-v2-content input')!
    input.value = 'beta'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await dialog.dialogOptions.buttons!.find(button => button.role === 'primary')!.handler!()
    await settle()
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0]).toMatchObject({ name: 'beta', app_id: 'com.example.channels' })
    expect(container.querySelector('[data-test="channel-introduction"]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[data-test="channel-table"]')!.style.display).not.toBe('none')
    expect(container.textContent).toContain('beta')
  })
})

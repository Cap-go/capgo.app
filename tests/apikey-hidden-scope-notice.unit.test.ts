// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import ApiKeyHiddenScopeNotice from '../src/components/ApiKeyHiddenScopeNotice.vue'
import DataTable from '../src/components/DataTable.vue'

vi.mock('@formkit/vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    FormKit: defineComponent({
      inheritAttrs: false,
      setup(_, { attrs }) {
        return () => h('input', attrs)
      },
    }),
  }
})

vi.mock('@vuepic/vue-datepicker', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    VueDatePicker: defineComponent({
      setup() {
        return () => h('div')
      },
    }),
  }
})

vi.mock('~/components/permissions/ChannelPermissionOverridesPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      setup() {
        return () => h('div')
      },
    }),
  }
})

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: async () => ({
    data: [
      {
        id: 1,
        name: 'Current organization key',
        key: 'current-org-key',
        key_hash: null,
        rbac_id: 'rbac-org-a',
        created_at: '2026-08-11T12:00:00.000Z',
        expires_at: null,
      },
      {
        id: 2,
        name: 'Hidden organization key',
        key: 'hidden-org-key',
        key_hash: null,
        rbac_id: 'rbac-org-b',
        created_at: '2026-08-11T11:00:00.000Z',
        expires_at: null,
      },
    ],
    error: null,
  }),
}))

vi.mock('~/services/nativeCompliance', () => ({
  isNativeAppStoreContext: () => false,
}))

vi.mock('~/services/permissions', () => ({
  checkPermissions: async () => true,
}))

vi.mock('~/services/supabase', () => {
  function createQuery(table: string) {
    let selectedId: string | null = null
    const query: Record<string, any> = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === 'id')
          selectedId = value
        return query
      },
      in: () => query,
      order: () => query,
      single: async () => ({
        data: selectedId
          ? { id: selectedId, name: selectedId === 'org-a' ? 'Organization A' : 'Organization B' }
          : null,
        error: null,
      }),
      then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) => {
        const data = table === 'role_bindings'
          ? [
              {
                id: 'binding-a',
                principal_id: 'rbac-org-a',
                scope_type: 'org',
                org_id: 'org-a',
                app_id: null,
                roles: { name: 'org_member' },
              },
              {
                id: 'binding-b',
                principal_id: 'rbac-org-b',
                scope_type: 'org',
                org_id: 'org-b',
                app_id: null,
                roles: { name: 'org_member' },
              },
            ]
          : table === 'roles'
            ? [
                {
                  id: 'role-org-member',
                  name: 'org_member',
                  scope_type: 'org',
                  description: null,
                  priority_rank: 10,
                },
              ]
            : []

        return Promise.resolve({ data, error: null }).then(resolve, reject)
      },
    }
    return query
  }

  return {
    useSupabase: () => ({
      auth: {
        getClaims: async () => ({ data: { claims: { sub: 'user-id' } } }),
      },
      from: (table: string) => createQuery(table),
    }),
  }
})

vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => ({
    openDialog: vi.fn(),
    onDialogDismiss: async () => undefined,
  }),
}))

vi.mock('~/stores/display', () => ({
  useDisplayStore: () => ({ NavTitle: '', defaultBack: '' }),
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => ({ user: { id: 'user-id' } }),
}))

vi.mock('~/stores/organization', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    currentOrganization: { gid: 'org-a', name: 'Organization A' },
    organizations: [
      { gid: 'org-a', name: 'Organization A', role: 'org_admin' },
      { gid: 'org-b', name: 'Organization B', role: 'org_admin' },
    ],
  })
  return {
    getRbacRoleI18nKey: () => null,
    useOrganizationStore: () => store,
  }
})

const mountedApps: App[] = []

function testI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
  })
}

function mountApp(app: App) {
  const container = document.createElement('div')
  app.use(testI18n())
  app.config.warnHandler = () => undefined
  app.mount(container)
  mountedApps.push(app)
  return container
}

function mountNotice(hiddenCount: number, isLoading = false) {
  const removeFilter = vi.fn()
  const app = createApp(ApiKeyHiddenScopeNotice, {
    hiddenCount,
    isLoading,
    onRemoveFilter: removeFilter,
  })
  const container = mountApp(app)

  return { container, removeFilter }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
})

describe('api key hidden-scope notice', () => {
  it('stays hidden when no matching keys are excluded or while keys are loading', () => {
    expect(mountNotice(0).container.querySelector('[role="status"]')).toBeNull()
    expect(mountNotice(3, true).container.querySelector('[role="status"]')).toBeNull()
  })

  it('renders the plural translated status and emits the remove-filter action', () => {
    const { container, removeFilter } = mountNotice(3)
    const status = container.querySelector('[role="status"]')
    const button = container.querySelector('button')

    expect(status?.querySelector('span')?.textContent?.trim()).toBe(
      '3 API keys are hidden by the current scope filter.',
    )
    expect(status?.querySelector('[data-test="scope-notice-icon"]')).not.toBeNull()
    expect(status?.classList.contains('border-slate-200')).toBe(true)
    expect(status?.classList.contains('bg-slate-50')).toBe(true)
    expect(status?.className).not.toContain('cyan')
    expect(button?.textContent?.trim()).toBe('Remove the filter')
    expect(button?.classList.contains('d-btn')).toBe(true)
    expect(button?.classList.contains('d-btn-link')).toBe(true)
    expect(button?.classList.contains('text-blue-600')).toBe(true)

    button?.click()

    expect(removeFilter).toHaveBeenCalledOnce()
  })

  it('renders the singular translated status', () => {
    const { container } = mountNotice(1)

    expect(container.querySelector('[role="status"] span')?.textContent?.trim()).toBe(
      '1 API key is hidden by the current scope filter.',
    )
  })

  it('renders the DataTable notice slot after its toolbar and before its table', () => {
    const root = defineComponent({
      setup() {
        return () => h(DataTable, {
          autoReload: false,
          columns: [],
          currentPage: 1,
          elementList: [],
          total: 0,
        }, {
          'table-notice': () => h('div', { 'data-test': 'table-notice' }, 'Scope notice'),
        })
      },
    })
    const container = mountApp(createApp(root))
    const toolbarButton = container.querySelector('button')
    const notice = container.querySelector('[data-test="table-notice"]')
    const table = container.querySelector('table')

    expect(toolbarButton).not.toBeNull()
    expect(notice).not.toBeNull()
    expect(table).not.toBeNull()
    expect(toolbarButton!.compareDocumentPosition(notice!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(notice!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('clears the active ApiKeys page scope, resets pagination, and preserves search', async () => {
    const DataTableStub = defineComponent({
      props: {
        currentPage: {
          type: Number,
          default: 1,
        },
        filters: {
          type: Object,
          default: () => ({}),
        },
        search: {
          type: String,
          default: '',
        },
      },
      emits: ['update:currentPage', 'update:search'],
      setup(props, { emit, slots }) {
        return () => h('section', {
          'data-test': 'api-key-data-table',
          'data-active-scope-count': Object.values(props.filters).filter(Boolean).length,
          'data-current-page': props.currentPage,
          'data-search': props.search,
        }, [
          h('button', {
            'data-test': 'set-search',
            'onClick': () => emit('update:search', 'organization'),
          }),
          h('button', {
            'data-test': 'set-page',
            'onClick': () => emit('update:currentPage', 3),
          }),
          slots['table-notice']?.(),
          h('table'),
        ])
      },
    })
    const ApiKeysPage = (await import('../src/pages/ApiKeys.vue')).default
    const app = createApp(ApiKeysPage)
    app.component('DataTable', DataTableStub)
    const container = mountApp(app)

    await flushPromises()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-test="api-key-data-table"]')?.getAttribute('data-active-scope-count')).toBe('1')
      expect(container.querySelector('[role="status"] button')).not.toBeNull()
    })

    const table = container.querySelector('[data-test="api-key-data-table"]')
    const setSearch = container.querySelector('[data-test="set-search"]') as HTMLButtonElement
    const setPage = container.querySelector('[data-test="set-page"]') as HTMLButtonElement

    setSearch.click()
    setPage.click()
    await nextTick()

    expect(table?.getAttribute('data-current-page')).toBe('3')
    expect(table?.getAttribute('data-search')).toBe('organization')

    const removeFilter = container.querySelector('[role="status"] button') as HTMLButtonElement

    removeFilter.click()
    await nextTick()

    expect(table?.getAttribute('data-active-scope-count')).toBe('0')
    expect(table?.getAttribute('data-current-page')).toBe('1')
    expect(table?.getAttribute('data-search')).toBe('organization')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})

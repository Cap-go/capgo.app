<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconSettings from '~icons/heroicons/cog-8-tooth'
import IconTrash from '~icons/heroicons/trash'
import { formatDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  appId: string
}>()

const emit = defineEmits<(event: 'misconfigured', misconfigured: boolean) => void>()

interface Channel {
  version: {
    id: number
    name: string
    created_at: string
    min_update_version: string | null
  } | null
  misconfigured: boolean | undefined
}
type Element = Database['public']['Tables']['channels']['Row'] & Channel
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const offset = 10
const { t } = useI18n()
const dialogStore = useDialogV2Store()
const organizationStore = useOrganizationStore()
const supabase = useSupabase()
const router = useRouter()
const main = useMainStore()
const total = ref(0)
const search = ref('')
const elements = ref<(Element)[]>([])
const isLoading = ref(true)
const currentPage = ref(1)
const versionId = ref<number | null>(null)
const filters = ref()
const newChannelName = ref('')
const canPromoteChannel = ref<Record<number, boolean>>({})
const canReadChannel = ref<Record<number, boolean>>({})
const canDeleteChannel = ref<Record<number, boolean>>({})

const canCreateChannel = computedAsync(async () => {
  if (!props.appId)
    return false
  return await checkPermissions('app.create_channel', { appId: props.appId })
}, false)

const currentVersionsNumber = computed(() => {
  return (currentPage.value - 1) * offset
})
const { currentOrganization } = storeToRefs(organizationStore)

async function addChannel(name: string) {
  if (!name || !main.user)
    return
  try {
    console.log('addChannel', name, versionId.value, main.user)
    const currentGid = organizationStore.currentOrganization?.gid
    if (!currentGid)
      return
    // { name: channelId, app_id: appId, version: data.id, created_by: userId }
    const { data: dataChannel } = await supabase
      .from('channels')
      .insert([
        {
          name,
          app_id: props.appId,
          version: versionId.value,
          owner_org: currentGid as string,
          created_by: main.user?.id,
        },
      ])
      .select()
    if (!dataChannel)
      return
    refreshData(true)
  }
  catch (error) {
    console.error(error)
  }
}

async function getData() {
  isLoading.value = true
  canPromoteChannel.value = {}
  canReadChannel.value = {}
  canDeleteChannel.value = {}
  try {
    let req = supabase
      .from('channels')
      .select(`
          id,
          name,
          app_id,
          public,
          version:app_versions!channels_version_fkey(
            id,
            name,
            created_at,
            min_update_version
          ),
          created_at,
          updated_at,
          disable_auto_update
          `, { count: 'exact' })
      .eq('app_id', props.appId)
      .range(currentVersionsNumber.value, currentVersionsNumber.value + offset - 1)

    if (search.value)
      req = req.like('name', `%${search.value}%`)

    if (columns.value.length) {
      columns.value.forEach((col) => {
        if (col.sortable && typeof col.sortable === 'string')
          req = req.order(col.key as any, { ascending: col.sortable === 'asc' })
      })
    }
    const { data: dataVersions, count } = await req
    if (!dataVersions)
      return
    elements.value.length = 0
    elements.value.push(...dataVersions as any)
    // console.log('count', count)
    total.value = count ?? 0
    if (count === 0) {
      showAddModal()
    }

    // Look for misconfigured channels
    // This will trigger if the channel disables updates based on metadata + if the metadata is undefined
    let anyMisconfigured = false
    const channels = dataVersions
      .filter(e => e.disable_auto_update === 'version_number')
      .map(e => e as any as Element)

    for (const channel of channels) {
      if (channel.version && channel.version.min_update_version === null) {
        channel.misconfigured = true
        anyMisconfigured = true
      }
    }

    // Inform the parent component if there are any misconfigured channels
    emit('misconfigured', anyMisconfigured)
    versionId.value = null
    await loadChannelPermissions(elements.value)
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}
async function refreshData(keepCurrentPage = false) {
  // console.log('refreshData')
  try {
    const page = currentPage.value
    if (!keepCurrentPage)
      currentPage.value = 1

    elements.value.length = 0
    await getData()
    if (keepCurrentPage)
      currentPage.value = page
  }
  catch (error) {
    console.error(error)
  }
}
async function deleteOne(one: Element) {
  if (!(await checkPermissions('channel.delete', { appId: props.appId, channelId: one.id }))) {
    toast.error(t('no-permission'))
    return false
  }

  dialogStore.openDialog({
    title: t('alert-confirm-delete'),
    description: `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${one.name}?`,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-delete'),
        role: 'danger',
        handler: async () => {
          try {
            const { error: delChanError } = await supabase
              .from('channels')
              .delete()
              .eq('app_id', props.appId)
              .eq('id', one.id)
            if (delChanError) {
              toast.error(t('cannot-delete-channel'))
            }
            else {
              await refreshData(true)
              toast.success(t('channel-deleted'))
            }
          }
          catch (error) {
            console.error(error)
            toast.error(t('cannot-delete-channel'))
          }
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function loadChannelPermissions(rows: Element[]) {
  if (!rows.length) {
    canPromoteChannel.value = {}
    canReadChannel.value = {}
    canDeleteChannel.value = {}
    return
  }

  const entries = await Promise.all(rows.map(async (row) => {
    const [canRead, canPromote, canDelete] = await Promise.all([
      checkPermissions('channel.read', { channelId: row.id }),
      checkPermissions('channel.promote_bundle', { channelId: row.id }),
      checkPermissions('channel.delete', { appId: props.appId, channelId: row.id }),
    ])
    return { id: row.id, canRead, canPromote, canDelete }
  }))

  const nextPromote: Record<number, boolean> = {}
  const nextRead: Record<number, boolean> = {}
  const nextDelete: Record<number, boolean> = {}
  for (const entry of entries) {
    nextRead[entry.id] = entry.canRead
    nextPromote[entry.id] = entry.canPromote
    nextDelete[entry.id] = entry.canDelete
  }
  canPromoteChannel.value = nextPromote
  canReadChannel.value = nextRead
  canDeleteChannel.value = nextDelete
}

columns.value = [
  {
    label: t('name'),
    key: 'name',
    mobile: true,
    sortable: true,
    head: true,
    renderFunction: (elem: Element) => {
      const canRead = !!canReadChannel.value[elem.id]
      const title = canRead ? '' : t('channel-permission-read-required')
      const className = canRead
        ? 'w-full text-left hover:underline'
        : 'w-full text-left text-gray-400 dark:text-gray-500 cursor-not-allowed'
      return h('button', {
        type: 'button',
        class: className,
        disabled: !canRead,
        title,
        onClick: () => {
          if (canRead)
            openOne(elem)
        },
      }, elem.name)
    },
  },
  {
    label: t('last-upload'),
    key: 'updated_at',
    mobile: false,
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.updated_at ?? ''),
  },
  {
    label: t('last-version'),
    key: 'version',
    mobile: true,
    sortable: true,
    displayFunction: (elem: Element) => elem.version?.name ?? t('channel-builtin'),
    onClick: (elem: Element) => openOneVersion(elem),
  },
  {
    label: t('misconfigured'),
    mobile: false,
    key: 'misconfigured',
    displayFunction: (elem: Element) => elem.misconfigured ? t('yes') : t('no'),
  },
  {
    key: 'action',
    label: t('action'),
    mobile: true,
    actions: [
      {
        icon: IconSettings,
        disabled: (elem: Element) => !canReadChannel.value[elem.id],
        title: (elem: Element) => (canReadChannel.value[elem.id]
          ? ''
          : t('channel-permission-read-required')),
        onClick: (elem: Element) => openOne(elem),
      },
      {
        icon: IconTrash,
        visible: (elem: Element) => !!canDeleteChannel.value[elem.id],
        onClick: (elem: Element) => deleteOne(elem),
      },
    ],
  },
]

async function reload() {
  try {
    elements.value.length = 0
    await getData()
  }
  catch (error) {
    console.error(error)
  }
}
async function showAddModal() {
  if (!currentOrganization.value || !canCreateChannel.value) {
    toast.error(t('no-permission'))
    return
  }

  newChannelName.value = ''
  dialogStore.openDialog({
    title: t('channel-create'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        role: 'primary',
        handler: async () => {
          const name = newChannelName.value.trim()
          console.log('newName', name)
          if (!name) {
            toast.error(t('missing-name'))
            return false
          }
          await addChannel(name)
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

async function openOneVersion(one: Element) {
  if (one.version?.id)
    router.push(`/app/${props.appId}/bundle/${one.version.id}`)
}

async function openOne(one: Element) {
  router.push(`/app/${props.appId}/channel/${one.id}`)
}
watch(props, async () => {
  await refreshData()
})
</script>

<template>
  <div>
    <DataTable
      v-model:filters="filters" v-model:columns="columns" v-model:current-page="currentPage" v-model:search="search"
      :total="total" :offset="offset" :element-list="elements"
      show-add
      filter-text="Filters"
      :is-loading="isLoading"
      :search-placeholder="t('search-by-name')"
      @add="showAddModal"
      @reload="reload()" @reset="refreshData()"
    />

    <!-- Teleport Content for Add Channel Modal -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('channel-create')" defer to="#dialog-v2-content">
      <div class="space-y-4">
        <FormKit
          v-model="newChannelName"
          type="text"
          :placeholder="t('channel-name-placeholder')"
        />
      </div>
    </Teleport>
  </div>
</template>

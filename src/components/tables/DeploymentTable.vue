<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import dayjs from 'dayjs'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { formatDate } from '~/services/date'
import { getLogDocUrl } from '~/services/logDocLinks'
import { defaultApiHost, useSupabase } from '~/services/supabase'

const props = defineProps<{
  deviceId?: string
  appId?: string
}>()

interface DeploymentData {
  app_id: string
  device_id: string
  action: string
  version_name: string
  version?: number
  created_at: string
}
type Element = DeploymentData

function getActiveOrder(columns: TableColumn[]) {
  return columns
    .filter(col => typeof col.sortable === 'string')
    .map(col => ({ key: col.key, sortable: col.sortable }))
}

const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()
const search = ref('')
const elements = ref<Element[]>([])
const isLoading = ref(false)
const currentPage = ref(1)
const range = ref<[Date, Date]>([dayjs().subtract(30, 'day').toDate(), new Date()])
const filters = ref()

const paginatedRange = computed(() => {
  const rangeStart = range.value ? range.value[0].getTime() : undefined
  const rangeEnd = range.value ? range.value[1].getTime() : undefined

  if (rangeStart && rangeEnd) {
    const timeDifference = rangeEnd - rangeStart
    const pageTimeOffset = timeDifference * (currentPage.value - 1)

    return {
      rangeStart: rangeStart + pageTimeOffset,
      rangeEnd: rangeEnd + pageTimeOffset,
    }
  }

  return {
    rangeStart,
    rangeEnd,
  }
})

async function getData() {
  isLoading.value = true
  try {
    const { data: currentSession } = await supabase.auth.getSession()!
    if (!currentSession.session)
      return
    const currentJwt = currentSession.session.access_token

    try {
      const response = await fetch(`${defaultApiHost}/private/stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${currentJwt ?? ''}`,
        },
        body: JSON.stringify({
          appId: props.appId,
          devicesId: props.deviceId ? [props.deviceId] : undefined,
          search: search.value ? search.value : undefined,
          order: getActiveOrder(columns.value),
          rangeStart: paginatedRange.value.rangeStart,
          rangeEnd: paginatedRange.value.rangeEnd,
          actions: [
            'set',
            'set_fail',
            'update_fail',
            'download_fail',
            'unzip_fail',
            'checksum_fail',
            'decrypt_fail',
            'reset',
          ],
        }),
      })

      if (!response.ok) {
        console.log('Cannot get stats', response.status)
        return
      }

      const dataD = await response.json() as DeploymentData[]
      elements.value.push(...dataD)
    }
    catch (err) {
      console.log('Cannot get deployments', err)
    }
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}
async function refreshData() {
  try {
    currentPage.value = 1
    elements.value.length = 0
    await getData()
  }
  catch (error) {
    console.error(error)
  }
}

function getActionDisplay(action: string): string {
  const actionMap: Record<string, string> = {
    set: t('action-set'),
    set_fail: t('action-set-fail'),
    update_fail: t('action-update-fail'),
    download_fail: t('action-download-fail'),
    unzip_fail: t('action-unzip-fail'),
    checksum_fail: t('action-checksum-fail'),
    decrypt_fail: t('action-decrypt-fail'),
    reset: t('action-reset'),
    delete: t('action-delete'),
  }
  return actionMap[action] || action
}

columns.value = [
  {
    label: t('created-at'),
    key: 'created_at',
    mobile: true,
    class: 'truncate max-w-8',
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.created_at ?? ''),
  },
  {
    label: t('action'),
    key: 'action',
    mobile: true,
    class: 'truncate max-w-8',
    sortable: true,
    displayFunction: (elem: Element) => getActionDisplay(elem.action),
    onClick: (elem: Element) => window.open(getLogDocUrl(elem.action), '_blank', 'noopener,noreferrer'),
  },
  {
    label: t('version'),
    key: 'version_name',
    class: 'truncate max-w-8',
    mobile: true,
    sortable: false,
    head: true,
    onClick: (elem: Element) => openOneVersion(elem),
  },
]

async function reload() {
  try {
    currentPage.value = 1
    elements.value.length = 0
    await getData()
  }
  catch (error) {
    console.error(error)
  }
}
async function openOneVersion(one: Element) {
  if (!props.appId)
    return
  if (!one.version) {
    const loadingToastId = toast.loading(t('loading-version'))
    const versionName = one.version_name

    const { data: versionRecord, error } = await supabase
      .from('app_versions')
      .select('id')
      .eq('app_id', props.appId)
      .eq('name', versionName)
      .single()
    if (error || !versionRecord?.id) {
      toast.dismiss(loadingToastId)
      toast.error(t('cannot-find-version'))
      return
    }
    one.version = versionRecord.id
    toast.dismiss(loadingToastId)
  }
  if (one.version)
    router.push(`/app/${props.appId}/bundle/${one.version}`)
  else
    toast.error(t('version-name-missing'))
}

onMounted(async () => {
  await refreshData()
})
watch(props, async () => {
  await refreshData()
})
watch(range, async () => {
  await refreshData()
})
</script>

<template>
  <div>
    <TableLog
      v-model:filters="filters"
      v-model:columns="columns"
      v-model:current-page="currentPage"
      v-model:search="search"
      v-model:range="range"
      :element-list="elements"
      :is-loading="isLoading"
      :auto-reload="false"
      :app-id="props.appId ?? ''"
      :search-placeholder="t('search-by-version')"
      @reload="reload()" @reset="refreshData()"
    />
  </div>
</template>

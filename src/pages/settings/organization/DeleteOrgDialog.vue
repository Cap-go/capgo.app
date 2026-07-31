<script setup lang="ts">
import type { Organization } from '~/stores/organization'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<Props>()
const { t } = useI18n()
const organizationStore = useOrganizationStore()
const router = useRouter()
const dialogStore = useDialogV2Store()
const deleteInput = ref('')

interface Props {
  org?: Organization
}

async function open() {
  dialogStore.openDialog({
    id: 'delete-org-confirm',
    title: t('delete-org'),
    description: `${t('please-confirm-org-del')}`.replace('%1', props.org?.name ?? ''),
    size: 'lg',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        id: 'confirm-button',
        role: 'danger',
        preventClose: true,
        handler: async () => {
          if (props.org) {
            if (deleteInput.value !== (props.org.name ?? '')) {
              toast.error(t('wrong-name-org-del').replace('%1', props.org.name ?? ''))
            }
            else {
              const { error } = await organizationStore.deleteOrganization(props.org.gid)

              if (error) {
                console.error('Delete organization error:', error)
                toast.error(`${t('cannot-del-org')}: ${error.message}`)
              }
              else {
                toast.success(t('org-deleted'))
                dialogStore.closeDialog({ text: t('button-confirm'), role: 'danger' })
                await organizationStore.fetchOrganizations()
                await organizationStore.setCurrentOrganizationToFirst()
                router.push('/apps')
              }
            }
          }
        },
      },
    ],
  })
}

defineExpose({
  open,
})
</script>

<template>
  <div>
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'delete-org-confirm'" to="#dialog-v2-content" defer>
      <div class="w-full">
        <label for="delete-org-confirm-input" class="sr-only">{{ t('type-organization-name-to-confirm') }}</label>
        <input
          id="delete-org-confirm-input"
          v-model="deleteInput"
          type="text"
          :placeholder="t('type-organization-name-to-confirm')"
          :aria-label="t('type-organization-name-to-confirm')"
          class="p-3 w-full rounded-lg border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600"
          @keydown.enter="$event.preventDefault()"
        >
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import RoleSelect from '~/components/forms/RoleSelect.vue'

interface Role {
  id: string
  name: string
  description: string
  priority_rank?: number
}

interface Props {
  open: boolean
  roles: Role[]
  currentRole?: string
  title?: string
  description?: string
  isLoading?: boolean
  confirmText?: string
  cancelText?: string
}

const props = withDefaults(defineProps<Props>(), {
  currentRole: '',
  title: '',
  description: '',
  isLoading: false,
  confirmText: '',
  cancelText: '',
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'confirm': [role: string]
  'cancel': []
}>()

const { t } = useI18n()
const selectedRole = ref(props.currentRole)

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    selectedRole.value = props.currentRole || ''
  }
})

watch(() => props.currentRole, (newRole) => {
  selectedRole.value = newRole || ''
})

const modalTitle = computed(() => props.title || t('select-role'))
const confirmButtonText = computed(() => props.confirmText || t('button-confirm'))
const cancelButtonText = computed(() => props.cancelText || t('cancel'))

function handleClose() {
  emit('update:open', false)
  emit('cancel')
}

function handleConfirm() {
  if (!selectedRole.value) {
    toast.error(t('please-select-permission'))
    return
  }
  emit('confirm', selectedRole.value)
  emit('update:open', false)
}
</script>

<template>
  <dialog :open="open" class="modal" @close="handleClose">
    <div class="modal-box max-w-2xl">
      <h3 class="text-lg font-bold">
        {{ modalTitle }}
      </h3>
      <p v-if="description" class="mt-2 text-sm text-gray-600">
        {{ description }}
      </p>

      <RoleSelect
        v-model="selectedRole"
        :roles="roles"
        :label="t('select-role')"
        class="mt-4"
      />

      <div class="modal-action">
        <button class="d-btn" @click="handleClose">
          {{ cancelButtonText }}
        </button>
        <button
          class="d-btn d-btn-primary"
          :disabled="!selectedRole || isLoading"
          @click="handleConfirm"
        >
          {{ confirmButtonText }}
        </button>
      </div>
    </div>
    <div class="modal-backdrop" @click="handleClose" />
  </dialog>
</template>

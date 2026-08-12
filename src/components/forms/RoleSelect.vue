<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import RoleCapabilitiesHint from '~/components/forms/RoleCapabilitiesHint.vue'
import { getRoleCapabilityKeys } from '~/services/roleCapabilities'

interface Role {
  id: string
  name: string
  description: string
  priority_rank?: number
}

interface Props {
  modelValue: string
  roles: Role[]
  placeholder?: string
  disabled?: boolean
  label?: string
  showDescription?: boolean
  required?: boolean
  /** Show an info button for the selected role's capabilities. */
  showCapabilities?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  disabled: false,
  label: '',
  showDescription: true,
  required: false,
  showCapabilities: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t, te } = useI18n()

const localValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})

const placeholderText = computed(() => props.placeholder || t('select-role'))
const selectId = useId()
const hasSelectedCapabilities = computed(() => {
  if (!props.showCapabilities || !localValue.value)
    return false
  const keys = getRoleCapabilityKeys(localValue.value)
  return !!keys && te(keys.summaryKey)
})

function roleOptionLabel(role: Role) {
  if (!props.showDescription)
    return role.name
  return role.description || role.name
}
</script>

<template>
  <div class="form-control">
    <label v-if="label" class="label" :for="selectId">
      <span class="label-text">{{ label }}</span>
    </label>
    <div class="flex items-center gap-2">
      <select
        :id="selectId"
        v-model="localValue"
        class="d-select min-w-0 flex-1"
        :aria-label="label || placeholderText"
        :disabled="disabled"
        :required="required"
      >
        <option value="">
          {{ placeholderText }}
        </option>
        <option
          v-for="role in roles"
          :key="role.id"
          :value="role.name"
        >
          {{ roleOptionLabel(role) }}
        </option>
      </select>
      <RoleCapabilitiesHint
        v-if="hasSelectedCapabilities"
        :role-name="localValue"
      />
    </div>
  </div>
</template>

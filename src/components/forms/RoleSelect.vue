<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

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
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  disabled: false,
  label: '',
  showDescription: true,
  required: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t } = useI18n()

const localValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})

const placeholderText = computed(() => props.placeholder || t('select-role'))
const selectId = useId()
</script>

<template>
  <div class="form-control">
    <label v-if="label" class="label" :for="selectId">
      <span class="label-text">{{ label }}</span>
    </label>
    <select
      :id="selectId"
      v-model="localValue"
      class="d-select"
      :aria-label="label || placeholderText"
      :disabled="disabled"
      :required="required"
    >
      <option value="">
        {{ placeholderText }}
      </option>
      <option v-for="role in roles" :key="role.id" :value="role.name">
        <template v-if="showDescription">
          {{ role.description }}
        </template>
        <template v-else>
          {{ role.name }}
        </template>
      </option>
    </select>
  </div>
</template>

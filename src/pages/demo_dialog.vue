<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useDialogV2Store } from '~/stores/dialogv2'

const dialogStore = useDialogV2Store()
const customInputValue = ref('')
const { t } = useI18n()

// Demo 1: Basic dialog
function openBasicDialog() {
  dialogStore.openDialog({
    title: 'Basic Dialog',
    description: 'This is a basic dialog with default content.',
    buttons: [
      {
        text: 'Cancel',
        role: 'cancel',
      },
      {
        text: 'Confirm',
        role: 'primary',
        handler: () => {
          console.log('Confirmed!')
        },
      },
    ],
  })
}

// Demo 2: Dialog with teleported input
function openInputDialog() {
  dialogStore.openDialog({
    title: t('dialog-with-custom-input'),
    description: 'This dialog has a custom input field teleported into it.',
    buttons: [
      {
        text: 'Cancel',
        role: 'cancel',
      },
      {
        text: 'Submit',
        role: 'primary',
        handler: () => {
          console.log(`Input value: ${customInputValue.value}`)
          customInputValue.value = ''
        },
      },
    ],
  })
}

// Demo 3: Danger dialog
function openDangerDialog() {
  dialogStore.openDialog({
    title: 'Danger Zone',
    description: 'This action cannot be undone.',
    size: 'lg',
    buttons: [
      {
        text: 'Cancel',
        role: 'cancel',
      },
      {
        text: 'Delete Forever',
        role: 'danger',
        handler: () => {
          console.log('Deleted!')
        },
      },
    ],
  })
}

// Demo 4: Complex form dialog
function openFormDialog() {
  dialogStore.openDialog({
    title: t('user-registration'),
    size: 'xl',
    buttons: [
      {
        text: t('cancel'),
        role: 'cancel',
      },
      {
        text: t('register'),
        role: 'primary',
        handler: () => {
          console.log('User registered!')
        },
      },
    ],
  })
}

// Reactive input value that can be read from outside
const externalInputValue = ref('')

function readExternalInput() {
  console.log(`External input value: ${externalInputValue.value}`)
}
</script>

<template>
  <div class="container p-8 mx-auto space-y-8">
    <div class="text-center">
      <h1 class="mb-4 text-3xl font-bold">
        DialogV2 Demo
      </h1>
      <p class="mb-8 text-gray-600 dark:text-gray-400">
        Demonstrates DialogV2 component with Vue Teleport functionality
      </p>
    </div>

    <!-- Demo Controls -->
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      <button
        class="d-btn d-btn-primary"
        @click="openBasicDialog"
      >
        Basic Dialog
      </button>

      <button
        class="d-btn d-btn-secondary"
        @click="openInputDialog"
      >
        Dialog with Input
      </button>

      <button
        class="d-btn d-btn-error"
        @click="openDangerDialog"
      >
        Danger Dialog
      </button>

      <button
        class="d-btn d-btn-accent"
        @click="openFormDialog"
      >
        Form Dialog
      </button>
    </div>

    <!-- External Input Demo -->
    <div class="p-6 bg-white rounded-lg shadow dark:bg-gray-800">
      <h2 class="mb-4 text-xl font-semibold">
        External Input Reading Demo
      </h2>
      <div class="flex gap-4 items-center">
        <label for="demo-external-input" class="sr-only">{{ t('demo-input-placeholder') }}</label>
        <input
          id="demo-external-input"
          v-model="externalInputValue"
          type="text"
          :placeholder="t('demo-input-placeholder')"
          :aria-label="t('demo-input-placeholder')"
          class="flex-1 input input-bordered"
        >
        <button
          class="d-btn d-btn-outline"
          @click="readExternalInput"
        >
          {{ t('read-value') }}
        </button>
      </div>
      <p class="mt-2 text-sm text-gray-500">
        {{ t('demo-external-input-desc') }}
      </p>
    </div>

    <!-- Teleport Content for Input Dialog -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('dialog-with-custom-input')" defer to="#dialog-v2-content">
      <div class="space-y-4">
        <div>
          <label for="custom-input" class="block mb-2 text-sm font-medium">{{ t('custom-input-field') }}</label>
          <input
            id="custom-input"
            v-model="customInputValue"
            type="text"
            :placeholder="t('demo-text-placeholder')"
            :aria-label="t('custom-input-field')"
            class="w-full input input-bordered"
          >
        </div>
        <div class="text-sm text-gray-500">
          {{ t('demo-teleport-desc') }}
        </div>
      </div>
    </Teleport>

    <!-- Teleport Content for Form Dialog -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('user-registration')" to="#dialog-v2-content">
      <div class="space-y-4">
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label for="first-name" class="block mb-2 text-sm font-medium">{{ t('first-name') }}</label>
            <input
              id="first-name"
              type="text"
              :placeholder="t('demo-fname-placeholder')"
              :aria-label="t('first-name')"
              class="w-full input input-bordered"
            >
          </div>
          <div>
            <label for="last-name" class="block mb-2 text-sm font-medium">{{ t('last-name') }}</label>
            <input
              id="last-name"
              type="text"
              :placeholder="t('demo-lname-placeholder')"
              :aria-label="t('last-name')"
              class="w-full input input-bordered"
            >
          </div>
        </div>

        <div>
          <label for="email" class="block mb-2 text-sm font-medium">{{ t('email') }}</label>
          <input
            id="email"
            type="email"
            :placeholder="t('demo-email-placeholder')"
            :aria-label="t('email')"
            class="w-full input input-bordered"
          >
        </div>

        <div>
          <label for="role" class="block mb-2 text-sm font-medium">{{ t('role') }}</label>
          <select id="role" class="w-full select select-bordered" :aria-label="t('role')">
            <option disabled selected>
              {{ t('demo-select-role') }}
            </option>
            <option>{{ t('demo-role-developer') }}</option>
            <option>{{ t('demo-role-designer') }}</option>
            <option>{{ t('demo-role-manager') }}</option>
          </select>
        </div>

        <div class="flex gap-2 items-center">
          <input
            id="terms"
            type="checkbox"
            class="checkbox"
          >
          <label for="terms" class="text-sm">
            I agree to the terms and conditions
          </label>
        </div>

        <div class="p-3 bg-blue-50 rounded-lg dark:bg-blue-900/20">
          <p class="text-sm text-blue-700 dark:text-blue-300">
            This entire form is teleported into the dialog using Vue Teleport!
          </p>
        </div>
      </div>
    </Teleport>
    <!-- Code Examples -->
    <div class="p-6 bg-white rounded-lg shadow dark:bg-gray-800">
      <h2 class="mb-4 text-xl font-semibold">
        Usage Examples
      </h2>

      <div class="space-y-4">
        <div>
          <h3 class="mb-2 font-medium">
            1. Basic Dialog
          </h3>
          <pre class="overflow-x-auto p-3 text-sm bg-gray-100 rounded dark:bg-gray-700"><code>dialogStore.openDialog({
  title: 'Basic Dialog',
  description: 'This is a basic dialog.',
  buttons: [
    { text: 'Cancel', role: 'cancel' },
    { text: 'Confirm', role: 'primary', handler: () => alert('Confirmed!') }
  ]
})</code></pre>
        </div>

        <div>
          <h3 class="mb-2 font-medium">
            2. Dialog with Teleported Content
          </h3>
          <pre class="overflow-x-auto p-3 text-sm bg-gray-100 rounded dark:bg-gray-700"><code>&lt;Teleport to="#dialog-v2-content" v-if="dialogStore.showDialog"&gt;
  &lt;input v-model="customValue" class="w-full input input-bordered" /&gt;
&lt;/Teleport&gt;</code></pre>
        </div>
      </div>
    </div>
  </div>
</template>

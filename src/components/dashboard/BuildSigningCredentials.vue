<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { invokeCapgoApi } from '~/services/capgoApi'

const props = defineProps<{ appId: string }>()
const { t } = useI18n()
const platform = ref<'ios' | 'android'>('ios')
const busy = ref(false)
const feedback = ref('')
const fields = {
  ios: [
    ['BUILD_CERTIFICATE_BASE64', '.p12', 'signing-certificate'],
    ['P12_PASSWORD', 'password', 'signing-certificate-password'],
    ['profile', '.mobileprovision', 'signing-provision-profile'],
    ['profileName', 'text', 'signing-profile-name'],
    ['APP_STORE_CONNECT_TEAM_ID', 'text', 'signing-team-id'],
    ['APPLE_KEY_ID', 'text', 'signing-apple-key-id'],
    ['APPLE_ISSUER_ID', 'text', 'signing-apple-issuer-id'],
    ['APPLE_KEY_CONTENT', '.p8', 'signing-apple-upload-key'],
  ],
  android: [
    ['ANDROID_KEYSTORE_FILE', '.jks,.keystore', 'signing-keystore'],
    ['KEYSTORE_KEY_ALIAS', 'text', 'signing-key-alias'],
    ['KEYSTORE_KEY_PASSWORD', 'password', 'signing-key-password'],
    ['KEYSTORE_STORE_PASSWORD', 'password', 'signing-store-password'],
    ['PLAY_CONFIG_JSON', '.json', 'signing-play-account'],
  ],
}

async function encodeFile(file: File) {
  if (file.size > 7 * 1024 * 1024)
    throw new Error('file-size')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

async function save(event: SubmitEvent) {
  if (busy.value)
    return
  const form = event.currentTarget as HTMLFormElement
  const values = new FormData(form)
  busy.value = true
  feedback.value = ''
  try {
    const credentials: Record<string, string> = {}
    for (const [key] of fields[platform.value]) {
      const value = values.get(key)
      if (value instanceof File && value.size)
        credentials[key] = await encodeFile(value)
      else if (typeof value === 'string' && value)
        credentials[key] = value
    }
    if (credentials.profile || credentials.profileName) {
      if (!credentials.profile || !credentials.profileName)
        throw new Error('incomplete-profile')
      credentials.CAPGO_IOS_PROVISIONING_MAP = JSON.stringify({
        [props.appId]: { profile: credentials.profile, name: credentials.profileName },
      })
      delete credentials.profile
      delete credentials.profileName
    }
    const { error } = await invokeCapgoApi('build/credentials/session', {
      method: 'PUT',
      retries: 0,
      body: { app_id: props.appId, platform: platform.value, mode: 'merge', credentials },
    })
    if (error)
      throw error
    form.reset()
    feedback.value = 'signing-saved'
  }
  catch (error) {
    feedback.value = error instanceof Error && error.message === 'incomplete-profile' ? 'signing-profile-required' : 'signing-save-failed'
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <details class="mb-6 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
    <summary class="cursor-pointer font-medium">
      {{ t('signing-credentials') }}
    </summary>
    <label class="mt-4 block">
      {{ t('platform') }}
      <select v-model="platform" class="select select-bordered" :disabled="busy" @change="feedback = ''">
        <option value="ios">iOS</option>
        <option value="android">Android</option>
      </select>
    </label>
    <form :key="platform" autocomplete="off" @submit.prevent="save">
      <fieldset :disabled="busy" class="grid gap-3 py-4">
        <label v-for="[key, type, label] in fields[platform]" :key="key" class="grid gap-1">
          {{ t(label) }}
          <input v-if="type.startsWith('.')" :name="key" type="file" :accept="type" class="file-input file-input-bordered">
          <input v-else :name="key" :type="type" class="input input-bordered">
        </label>
        <button type="submit" class="btn btn-primary justify-self-start">
          {{ t('save') }}
        </button>
      </fieldset>
    </form>
    <p v-if="feedback" role="status">
      {{ t(feedback) }}
    </p>
  </details>
</template>

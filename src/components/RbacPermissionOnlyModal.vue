<script setup lang="ts">
import type { Permission } from '~/services/permissions'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconUserCircle from '~icons/heroicons/user-circle'
import { userHasPermission } from '~/services/permissions'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  // Human-friendly heading, e.g. "Billing access required". Never a raw permission key.
  title: string
  // Optional human-friendly body. Falls back to a generic message.
  description?: string
  // The RBAC permission(s) this section needs. Used to find who can actually help.
  permission: Permission | Permission[]
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const mainStore = useMainStore()

const contacts = ref<{ key: string, email: string, image_url: string }[]>([])
const isLoading = ref(true)

function getMemberKey(member: { uid?: string | null, id?: string | number | null, email: string }) {
  return String(member.uid ?? member.id ?? member.email)
}

// The current user is the one being blocked, so never list them as someone to contact.
function isCurrentUser(member: { uid?: string | null, email: string }) {
  const currentUser = mainStore.user
  if (!currentUser)
    return false
  if (member.uid && member.uid === currentUser.id)
    return true
  return !!member.email && member.email.toLowerCase() === currentUser.email?.toLowerCase()
}

// Token to ignore stale completions when a newer load starts (the watch can refire mid-flight).
let loadId = 0

async function loadContacts() {
  const myLoadId = ++loadId
  isLoading.value = true
  contacts.value = []

  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId) {
    if (myLoadId === loadId)
      isLoading.value = false
    return
  }

  const permissions = Array.isArray(props.permission) ? props.permission : [props.permission]

  try {
    const members = await organizationStore.getMembers((signedImages) => {
      // Ignore signed-image updates that arrive after a newer load superseded this one.
      if (myLoadId !== loadId)
        return
      contacts.value = contacts.value.map((contact) => {
        const signedImage = signedImages.get(contact.key)
        return signedImage ? { ...contact, image_url: signedImage } : contact
      })
    })

    // Keep only members who actually hold (any of) the required permission(s) and are
    // not the blocked user themselves - those are the people worth contacting.
    const eligible = await Promise.all(members.map(async (member) => {
      if (isCurrentUser(member) || !member.uid)
        return null
      for (const permission of permissions) {
        if (await userHasPermission(permission, member.uid, { orgId }))
          return member
      }
      return null
    }))

    // A newer load started while we were awaiting; discard this stale result.
    if (myLoadId !== loadId)
      return

    contacts.value = eligible
      .filter((member): member is NonNullable<typeof member> => member !== null)
      .map(member => ({ key: getMemberKey(member), email: member.email, image_url: member.image_url }))
  }
  catch (e) {
    console.error('Failed to load people who can grant access:', e)
  }
  finally {
    if (myLoadId === loadId)
      isLoading.value = false
  }
}

function onBackdropClick() {
  emit('close')
}

onMounted(loadContacts)
watch(() => [props.permission, organizationStore.currentOrganization?.gid], loadContacts)
</script>

<template>
  <div
    class="flex absolute inset-0 z-10 flex-col justify-center items-center bg-white/60 dark:bg-gray-900/60"
    @click="onBackdropClick"
  >
    <div
      class="p-8 text-center bg-white rounded-xl border shadow-xl dark:bg-gray-800 border-blue-200 dark:border-blue-700 max-w-md"
      @click.stop
    >
      <div class="flex justify-center mb-4">
        <div class="flex justify-center items-center w-16 h-16 bg-blue-100 rounded-full dark:bg-blue-900/30">
          <svg class="w-8 h-8 text-blue-500" viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
      </div>
      <h2 class="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
        {{ title }}
      </h2>
      <p class="mb-4 text-gray-600 dark:text-gray-400">
        {{ description ?? t('access-required-description') }}
      </p>
      <div v-if="isLoading" class="flex justify-center py-2">
        <div class="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
      <div v-else-if="contacts.length > 0" class="mt-4 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
        <p class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          {{ t('access-contact-people') }}:
        </p>
        <div class="flex flex-wrap gap-2 justify-center">
          <div
            v-for="contact in contacts"
            :key="contact.email"
            class="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-gray-800 rounded-full border border-gray-200 dark:border-gray-600"
          >
            <img
              v-if="contact.image_url"
              :src="contact.image_url"
              :alt="contact.email"
              class="w-5 h-5 rounded-full"
            >
            <IconUserCircle v-else class="w-5 h-5 text-gray-400" />
            <span class="text-sm text-gray-700 dark:text-gray-300">{{ contact.email }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

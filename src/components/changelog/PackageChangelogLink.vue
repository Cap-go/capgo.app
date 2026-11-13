<script setup lang="ts">
import type { ChangelogPlugin } from '~/services/changelog'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ChangelogUpdateBadge from '~/components/changelog/ChangelogUpdateBadge.vue'
import { changelogLocation, isNewerVersion, packageChangelog, UPDATER_PACKAGE } from '~/services/changelog'

const props = defineProps<{
  name: string
  version: string | null | undefined
  fromVersion?: string | null
  plugins?: ChangelogPlugin[]
}>()
const target = computed(() => packageChangelog(props.name, props.plugins))
const latest = computed(() => props.plugins?.find(plugin => plugin.name === props.name)?.version)
const { t } = useI18n()
const comparing = computed(() => !!props.fromVersion && isNewerVersion(props.version, props.fromVersion))
// Wait for the shared catalog before checking each Capgo plugin individually.
const waitingForCatalog = computed(() => props.name.startsWith('@capgo/') && props.name !== UPDATER_PACKAGE && !props.plugins?.length)
</script>

<template>
  <router-link
    v-if="comparing || waitingForCatalog"
    :to="changelogLocation(target.product, { repo: target.repo, since: comparing ? fromVersion : version, to: comparing ? version : null })"
    class="text-xs text-azure-600 hover:underline dark:text-azure-300"
    data-test="changelog-comparison-link"
    @click.stop
  >
    {{ t('changelog-whats-new') }}
  </router-link>
  <ChangelogUpdateBadge
    v-else
    :product="target.product"
    :repo="target.repo"
    :current="version"
    :latest="latest"
    show-current
    show-notes
  />
</template>

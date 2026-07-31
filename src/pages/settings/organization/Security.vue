<script setup lang="ts">
import { FunctionsHttpError } from '@supabase/supabase-js'
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCheck from '~icons/heroicons/check-circle'
import IconWarning from '~icons/heroicons/exclamation-triangle'
import IconFingerprint from '~icons/heroicons/finger-print'
import IconKey from '~icons/heroicons/key'
import IconLock from '~icons/heroicons/lock-closed'
import IconShield from '~icons/heroicons/shield-check'
import IconUser from '~icons/heroicons/user'
import SsoConfiguration from '~/components/organizations/SsoConfiguration.vue'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { createSignedImageUrl, getImmediateImageUrl } from '~/services/storage'
import { getCurrentPlanNameOrg, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

interface MemberWithMfaStatus {
  uid: string
  email: string
  image_url: string
  role: string
  is_tmp: boolean
  has_2fa: boolean
}

interface MemberWithPasswordPolicyStatus {
  uid: string
  email: string
  first_name: string | null
  last_name: string | null
  image_url: string
  role: string
  is_tmp: boolean
  password_policy_compliant: boolean
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()
const router = useRouter()
const supabase = useSupabase()
const isLoading = ref(true)
const isSaving = ref(false)
const hideExternalPurchaseFlows = isNativeAppStoreContext()

displayStore.NavTitle = t('security')

const { currentOrganization } = storeToRefs(organizationStore)
const SUPABASE_MAX_PASSWORD_LENGTH = 72

// Hashed API keys enforcement state
const enforceHashedApiKeys = ref(false)

// Encrypted bundles enforcement state
const enforceEncryptedBundles = ref(false)
const requiredEncryptionKey = ref<string | null>(null)
const nonCompliantBundleCounts = ref<{ non_encrypted_count: number, wrong_key_count: number, total_non_compliant: number } | null>(null)

// 2FA enforcement state
const enforcing2fa = ref(false)
const membersWithMfaStatus = ref<MemberWithMfaStatus[]>([])
const impactedMembers = ref<MemberWithMfaStatus[]>([])

// Password policy state
const policyEnabled = ref(false)
const minLength = ref(10)
const requireUppercase = ref(true)
const requireNumber = ref(true)
const requireSpecial = ref(true)

// Members to be affected when enabling password policy
const affectedMembers = ref<Array<{ email: string, first_name: string | null, last_name: string | null }>>([])

// Password policy compliance tracking
const membersWithPasswordPolicyStatus = ref<MemberWithPasswordPolicyStatus[]>([])
const nonCompliantPasswordMembers = ref<MemberWithPasswordPolicyStatus[]>([])

// API key expiration policy state
const requireApikeyExpiration = ref(false)
const maxApikeyExpirationDays = ref<number | null>(null)

// Current plan name for feature gating
const currentPlanName = ref<string | null>(null)
const isEnterprisePlan = computed(() => currentPlanName.value === 'Enterprise')

const hasOrgPerm = computedAsync(async () => {
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.update_settings', { orgId })
}, false)

const compliantMembersCount = computed(() => {
  return membersWithMfaStatus.value.filter(m => m.has_2fa && !m.is_tmp).length
})

const nonCompliantMembersCount = computed(() => {
  return membersWithMfaStatus.value.filter(m => !m.has_2fa && !m.is_tmp).length
})

const totalMembersCount = computed(() => {
  return membersWithMfaStatus.value.filter(m => !m.is_tmp).length
})

// Password policy compliance computed properties
const passwordCompliantMembersCount = computed(() => {
  return membersWithPasswordPolicyStatus.value.filter(m => m.password_policy_compliant && !m.is_tmp).length
})

const passwordNonCompliantMembersCount = computed(() => {
  return membersWithPasswordPolicyStatus.value.filter(m => !m.password_policy_compliant && !m.is_tmp).length
})

const totalPasswordPolicyMembersCount = computed(() => {
  return membersWithPasswordPolicyStatus.value.filter(m => !m.is_tmp).length
})

interface MemberImageSource {
  key: string
  imageUrl?: string | null
}
let mfaMemberImageLoadRun = 0
let passwordMemberImageLoadRun = 0

async function loadSignedMemberImages(
  sources: MemberImageSource[],
  isCurrentRun: () => boolean,
  applySignedImages: (signedImages: Map<string, string>) => void,
) {
  const signedEntries = await Promise.all(sources.map(async (source) => {
    if (!source.key || !source.imageUrl || getImmediateImageUrl(source.imageUrl))
      return null

    try {
      const signedImage = await createSignedImageUrl(source.imageUrl)
      return signedImage ? [source.key, signedImage] as const : null
    }
    catch (error) {
      console.warn('Cannot load signed security member image', { memberKey: source.key, error })
      return null
    }
  }))

  if (!isCurrentRun())
    return

  const signedImages = new Map<string, string>()
  for (const entry of signedEntries) {
    if (entry)
      signedImages.set(entry[0], entry[1])
  }

  if (signedImages.size > 0)
    applySignedImages(signedImages)
}

function applyMfaMemberImages(signedImages: Map<string, string>) {
  membersWithMfaStatus.value = membersWithMfaStatus.value.map((member) => {
    const signedImage = signedImages.get(member.uid)
    return signedImage ? { ...member, image_url: signedImage } : member
  })
  impactedMembers.value = membersWithMfaStatus.value.filter(m => !m.has_2fa && !m.is_tmp)
}

function applyPasswordMemberImages(signedImages: Map<string, string>) {
  membersWithPasswordPolicyStatus.value = membersWithPasswordPolicyStatus.value.map((member) => {
    const signedImage = signedImages.get(member.uid)
    return signedImage ? { ...member, image_url: signedImage } : member
  })
  nonCompliantPasswordMembers.value = membersWithPasswordPolicyStatus.value.filter(m => !m.password_policy_compliant && !m.is_tmp)
}

function acronym(email: string) {
  let res = 'NA'
  const prefix = email?.split('@')[0]
  if (!prefix)
    return res

  if (prefix.length > 2 && prefix.includes('.')) {
    const parts = prefix.split('.')
    const firstName = parts[0]
    const lastName = parts[1]
    if (firstName && lastName) {
      res = (firstName[0] + lastName[0]).toUpperCase()
    }
  }
  else if (prefix.length >= 2) {
    res = (prefix[0] + prefix[1]).toUpperCase()
  }
  else if (prefix.length === 1) {
    res = (`${prefix[0]}X`).toUpperCase()
  }
  return res
}

async function hasVerified2faFactor() {
  const { data: mfaFactors, error } = await supabase.auth.mfa.listFactors()
  if (error) {
    console.error('Error checking your 2FA status:', error)
    return null
  }
  const verifiedFactor = mfaFactors?.all.find(factor => factor.status === 'verified')
  return !!verifiedFactor
}

async function updateOrganizationSecuritySettings(body: Record<string, unknown>) {
  if (!currentOrganization.value?.gid)
    return { error: new Error('missing_organization') }

  return supabase.functions.invoke('organization', {
    method: 'PUT',
    body: {
      orgId: currentOrganization.value.gid,
      ...body,
    },
  })
}

// Load current password policy settings
function loadPolicyFromOrg() {
  const config = currentOrganization.value?.password_policy_config
  if (config?.enabled) {
    policyEnabled.value = config.enabled
    minLength.value = Math.min(config.min_length ?? 10, SUPABASE_MAX_PASSWORD_LENGTH)
    requireUppercase.value = config.require_uppercase ?? true
    requireNumber.value = config.require_number ?? true
    requireSpecial.value = config.require_special ?? true
  }
  else {
    policyEnabled.value = false
    minLength.value = 10
    requireUppercase.value = true
    requireNumber.value = true
    requireSpecial.value = true
  }
}

// Load API key expiration policy settings
function loadApikeyPolicyFromOrg() {
  requireApikeyExpiration.value = currentOrganization.value?.require_apikey_expiration ?? false
  maxApikeyExpirationDays.value = currentOrganization.value?.max_apikey_expiration_days ?? null
}

async function goToMembersPage(closeDialog = false) {
  if (closeDialog)
    await dialogStore.closeDialog()
  await router.push('/settings/organization/members')
}

async function loadData() {
  if (!currentOrganization.value?.gid)
    return

  isLoading.value = true

  try {
    // Load current org's security settings
    const { data: orgData, error: orgError } = await supabase
      .from('orgs')
      .select('enforcing_2fa, enforce_hashed_api_keys, enforce_encrypted_bundles, required_encryption_key')
      .eq('id', currentOrganization.value.gid)
      .single()

    if (orgError) {
      console.error('Error loading org settings:', orgError)
      toast.error(t('error-loading-settings'))
      return
    }

    enforcing2fa.value = orgData?.enforcing_2fa ?? false
    enforceHashedApiKeys.value = orgData?.enforce_hashed_api_keys ?? false
    enforceEncryptedBundles.value = orgData?.enforce_encrypted_bundles ?? false
    requiredEncryptionKey.value = orgData?.required_encryption_key ?? null

    // Load members with their 2FA status
    await loadMembersWithMfaStatus()

    // Load password policy settings
    loadPolicyFromOrg()

    // Load API key expiration policy settings
    loadApikeyPolicyFromOrg()

    // Load current plan name for feature gating
    try {
      currentPlanName.value = await getCurrentPlanNameOrg(currentOrganization.value.gid)
    }
    catch (planError) {
      console.error('Error loading plan name:', planError)
      currentPlanName.value = null
    }

    // Load members with their password policy compliance status
    await loadMembersWithPasswordPolicyStatus()
  }
  catch (error) {
    console.error('Error loading security settings:', error)
    toast.error(t('error-loading-settings'))
  }
  finally {
    isLoading.value = false
  }
}

async function loadMembersWithMfaStatus() {
  if (!currentOrganization.value?.gid || !hasOrgPerm.value)
    return

  try {
    // Get org members
    const { data: members, error: membersError } = await supabase
      .rpc('get_org_members', {
        guild_id: currentOrganization.value.gid,
      })

    if (membersError) {
      console.error('Error loading members:', membersError)
      return
    }

    // Get 2FA status for all members
    const { data: mfaStatus, error: mfaError } = await supabase
      .rpc('check_org_members_2fa_enabled', {
        org_id: currentOrganization.value.gid,
      })

    if (mfaError) {
      console.error('Error loading MFA status:', mfaError)
      // Still continue with members, just mark 2FA as unknown
    }

    // Create a map of user_id to 2FA status
    const mfaMap = new Map<string, boolean>()
    if (mfaStatus) {
      for (const status of mfaStatus) {
        mfaMap.set(status.user_id, status['2fa_enabled'])
      }
    }

    const imageLoadRun = ++mfaMemberImageLoadRun
    const imageSources: MemberImageSource[] = []
    // Merge members with MFA status
    membersWithMfaStatus.value = (members || []).map((member) => {
      imageSources.push({ key: member.uid, imageUrl: member.image_url })
      return {
        uid: member.uid,
        email: member.email,
        image_url: getImmediateImageUrl(member.image_url) || '',
        role: member.role,
        is_tmp: member.is_tmp,
        has_2fa: mfaMap.get(member.uid) ?? false,
      }
    })

    // Calculate impacted members (those without 2FA, excluding pending invites)
    impactedMembers.value = membersWithMfaStatus.value.filter(m => !m.has_2fa && !m.is_tmp)
    void loadSignedMemberImages(
      imageSources,
      () => imageLoadRun === mfaMemberImageLoadRun,
      applyMfaMemberImages,
    )
  }
  catch (error) {
    console.error('Error loading members with MFA status:', error)
  }
}

async function loadMembersWithPasswordPolicyStatus() {
  if (!currentOrganization.value?.gid || !hasOrgPerm.value)
    return

  // Only load if password policy is enabled
  const config = currentOrganization.value?.password_policy_config
  if (!config?.enabled)
    return

  try {
    // Get org members
    const { data: members, error: membersError } = await supabase
      .rpc('get_org_members', {
        guild_id: currentOrganization.value.gid,
      })

    if (membersError) {
      console.error('Error loading members:', membersError)
      return
    }

    // Get password policy compliance status for all members
    const { data: complianceStatus, error: complianceError } = await supabase
      .rpc('check_org_members_password_policy', {
        org_id: currentOrganization.value.gid,
      })

    if (complianceError) {
      console.error('Error loading password policy compliance status:', complianceError)
      // Still continue with members, just mark compliance as unknown
    }

    // Create a map of user_id to compliance status
    const complianceMap = new Map<string, { compliant: boolean, first_name: string | null, last_name: string | null }>()
    if (complianceStatus) {
      for (const status of complianceStatus) {
        complianceMap.set(status.user_id, {
          compliant: status.password_policy_compliant,
          first_name: status.first_name,
          last_name: status.last_name,
        })
      }
    }

    const imageLoadRun = ++passwordMemberImageLoadRun
    const imageSources: MemberImageSource[] = []
    // Merge members with password policy compliance status
    membersWithPasswordPolicyStatus.value = (members || []).map((member) => {
      const compliance = complianceMap.get(member.uid)
      imageSources.push({ key: member.uid, imageUrl: member.image_url })
      return {
        uid: member.uid,
        email: member.email,
        first_name: compliance?.first_name || null,
        last_name: compliance?.last_name || null,
        image_url: getImmediateImageUrl(member.image_url) || '',
        role: member.role,
        is_tmp: member.is_tmp,
        password_policy_compliant: compliance?.compliant ?? false,
      }
    })

    // Calculate non-compliant members (excluding pending invites)
    nonCompliantPasswordMembers.value = membersWithPasswordPolicyStatus.value.filter(m => !m.password_policy_compliant && !m.is_tmp)
    void loadSignedMemberImages(
      imageSources,
      () => imageLoadRun === passwordMemberImageLoadRun,
      applyPasswordMemberImages,
    )
  }
  catch (error) {
    console.error('Error loading members with password policy status:', error)
  }
}

async function toggle2faEnforcement() {
  if (!currentOrganization.value?.gid || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  const newValue = !enforcing2fa.value

  if (newValue) {
    const hasSelf2fa = await hasVerified2faFactor()
    if (hasSelf2fa === null) {
      toast.error(t('error-loading-settings'))
      return
    }
    if (!hasSelf2fa) {
      toast.error(t('2fa-enforcement-self-2fa-required'))
      return
    }
  }

  if (newValue && impactedMembers.value.length > 0) {
    // Show warning dialog with impacted members
    dialogStore.openDialog({
      id: 'enforce-2fa-warning',
      title: t('2fa-enforcement-warning-title'),
      description: t('2fa-enforcement-warning-description'),
      size: 'lg',
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
        {
          text: t('2fa-enforcement-enable-anyway'),
          role: 'danger',
          handler: async () => {
            await save2faEnforcement(true)
          },
        },
      ],
    })

    await dialogStore.onDialogDismiss()
    return
  }

  // No impacted members, proceed directly
  await save2faEnforcement(newValue)
}

async function save2faEnforcement(value: boolean) {
  if (!currentOrganization.value?.gid)
    return

  isSaving.value = true

  try {
    const { error } = await updateOrganizationSecuritySettings({
      enforcing_2fa: value,
    })

    if (error) {
      if (error instanceof FunctionsHttpError && error.context instanceof Response) {
        try {
          const payload = await error.context.clone().json<{ error?: string }>()
          if (payload.error === 'requires_2fa_to_enforce_2fa') {
            toast.error(t('2fa-enforcement-self-2fa-required'))
            return
          }
        }
        catch {
          console.warn('Could not parse org security function error payload')
        }
      }
      console.error('Error updating 2FA enforcement:', error)
      toast.error(t('error-saving-settings'))
      return
    }

    enforcing2fa.value = value
    toast.success(value ? t('2fa-enforcement-enabled') : t('2fa-enforcement-disabled'))
  }
  catch (error) {
    console.error('Error saving 2FA enforcement:', error)
    toast.error(t('error-saving-settings'))
  }
  finally {
    isSaving.value = false
  }
}

async function toggleEnforceHashedApiKeys() {
  if (!currentOrganization.value || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  const newValue = !enforceHashedApiKeys.value
  const previousValue = enforceHashedApiKeys.value

  // Optimistic update
  enforceHashedApiKeys.value = newValue

  isSaving.value = true

  try {
    const { error } = await updateOrganizationSecuritySettings({
      enforce_hashed_api_keys: newValue,
    })

    if (error) {
      console.error('Failed to update enforce_hashed_api_keys:', error)
      // Revert optimistic update
      enforceHashedApiKeys.value = previousValue
      toast.error(t('error-saving-settings'))
      return
    }

    await organizationStore.fetchOrganizations()
    toast.success(newValue ? t('hashed-api-keys-enforcement-enabled') : t('hashed-api-keys-enforcement-disabled'))
  }
  catch (error) {
    console.error('Error saving hashed API keys enforcement:', error)
    enforceHashedApiKeys.value = previousValue
    toast.error(t('error-saving-settings'))
  }
  finally {
    isSaving.value = false
  }
}

async function countNonCompliantBundles(): Promise<{ non_encrypted_count: number, wrong_key_count: number, total_non_compliant: number } | 'error'> {
  if (!currentOrganization.value)
    return 'error'

  const { data, error } = await supabase.rpc('count_non_compliant_bundles', {
    org_id: currentOrganization.value.gid,
    required_key: requiredEncryptionKey.value || undefined,
  })

  if (error) {
    console.error('Error counting non-compliant bundles:', error)
    toast.error(t('error-counting-non-compliant-bundles'))
    return 'error'
  }

  if (!data || !data[0]) {
    console.error('No data returned from count_non_compliant_bundles')
    toast.error(t('error-counting-non-compliant-bundles'))
    return 'error'
  }

  return data[0]
}

async function toggleEnforceEncryptedBundles() {
  if (!currentOrganization.value || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  const newValue = !enforceEncryptedBundles.value

  // If disabling, just disable without checks
  if (!newValue) {
    await saveEncryptedBundlesEnforcement(false, requiredEncryptionKey.value)
    return
  }

  // If enabling, count non-compliant bundles first
  isSaving.value = true
  const counts = await countNonCompliantBundles()
  isSaving.value = false

  // If counting failed, abort - don't proceed with potentially destructive operation
  if (counts === 'error') {
    return
  }

  if (counts.total_non_compliant > 0) {
    nonCompliantBundleCounts.value = counts

    // Show warning dialog
    dialogStore.openDialog({
      id: 'enforce-encrypted-bundles-warning',
      title: t('encrypted-bundles-enforcement-warning-title'),
      description: t('encrypted-bundles-enforcement-warning-description'),
      size: 'lg',
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
        {
          text: t('encrypted-bundles-enforcement-enable-anyway'),
          role: 'danger',
          handler: async () => {
            await saveEncryptedBundlesEnforcement(true, requiredEncryptionKey.value, true)
          },
        },
      ],
    })

    await dialogStore.onDialogDismiss()
    return
  }

  // No non-compliant bundles, proceed directly
  await saveEncryptedBundlesEnforcement(true, requiredEncryptionKey.value)
}

async function saveEncryptedBundlesEnforcement(enable: boolean, keyFingerprint: string | null, deleteNonCompliant: boolean = false) {
  if (!currentOrganization.value)
    return

  const previousEnforcement = enforceEncryptedBundles.value
  const previousKey = requiredEncryptionKey.value

  // Optimistic update
  enforceEncryptedBundles.value = enable
  requiredEncryptionKey.value = keyFingerprint

  isSaving.value = true

  try {
    // If enabling and we need to delete non-compliant bundles, do that first
    if (enable && deleteNonCompliant) {
      const { error: deleteError } = await supabase.rpc('delete_non_compliant_bundles', {
        org_id: currentOrganization.value.gid,
        required_key: keyFingerprint || undefined,
      })

      if (deleteError) {
        console.error('Failed to delete non-compliant bundles:', deleteError)
        enforceEncryptedBundles.value = previousEnforcement
        requiredEncryptionKey.value = previousKey
        toast.error(t('error-deleting-non-compliant-bundles'))
        return
      }
    }

    const { error } = await updateOrganizationSecuritySettings({
      enforce_encrypted_bundles: enable,
      required_encryption_key: keyFingerprint || null,
    })

    if (error) {
      console.error('Failed to update enforce_encrypted_bundles:', error)
      enforceEncryptedBundles.value = previousEnforcement
      requiredEncryptionKey.value = previousKey
      toast.error(t('error-saving-settings'))
      return
    }

    await organizationStore.fetchOrganizations()
    if (enable) {
      const deletedCount = nonCompliantBundleCounts.value?.total_non_compliant ?? 0
      if (deletedCount > 0) {
        toast.success(t('encrypted-bundles-enforcement-enabled-with-deletion', { count: deletedCount }))
      }
      else {
        toast.success(t('encrypted-bundles-enforcement-enabled'))
      }
    }
    else {
      toast.success(t('encrypted-bundles-enforcement-disabled'))
    }

    nonCompliantBundleCounts.value = null
  }
  catch (error) {
    console.error('Error saving encrypted bundles enforcement:', error)
    enforceEncryptedBundles.value = previousEnforcement
    requiredEncryptionKey.value = previousKey
    toast.error(t('error-saving-settings'))
  }
  finally {
    isSaving.value = false
  }
}

async function updateRequiredEncryptionKey() {
  if (!currentOrganization.value || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  // Validate key length (should be exactly 21 characters or empty)
  const key = requiredEncryptionKey.value?.trim() || null
  if (key && key.length !== 21) {
    toast.error(t('encryption-key-must-be-21-chars'))
    return
  }

  // If enforcement is already enabled and we're changing the key, check for impacts
  if (enforceEncryptedBundles.value && key !== null) {
    isSaving.value = true
    const oldKey = requiredEncryptionKey.value
    requiredEncryptionKey.value = key
    const counts = await countNonCompliantBundles()
    requiredEncryptionKey.value = oldKey
    isSaving.value = false

    // If counting failed, abort - don't proceed with potentially destructive operation
    if (counts === 'error') {
      return
    }

    if (counts.wrong_key_count > 0) {
      nonCompliantBundleCounts.value = counts

      // Show warning dialog for key change
      dialogStore.openDialog({
        id: 'change-encryption-key-warning',
        title: t('change-encryption-key-warning-title'),
        description: t('change-encryption-key-warning-description'),
        size: 'lg',
        buttons: [
          {
            text: t('button-cancel'),
            role: 'cancel',
          },
          {
            text: t('change-encryption-key-confirm'),
            role: 'danger',
            handler: async () => {
              await saveEncryptedBundlesEnforcement(true, key, true)
            },
          },
        ],
      })

      await dialogStore.onDialogDismiss()
      return
    }
  }

  // No impact or enforcement is disabled, just save
  await saveEncryptedBundlesEnforcement(enforceEncryptedBundles.value, key)
}

async function copyEmailList() {
  const emails = impactedMembers.value.map(m => m.email).join(', ')
  try {
    await navigator.clipboard.writeText(emails)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
    dialogStore.openDialog({
      title: t('cannot-copy'),
      description: emails,
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
}

async function copyPasswordPolicyEmailList() {
  const emails = nonCompliantPasswordMembers.value.map(m => m.email).join(', ')
  try {
    await navigator.clipboard.writeText(emails)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
    dialogStore.openDialog({
      title: t('cannot-copy'),
      description: emails,
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
}

// Check impact before enabling password policy
async function checkPasswordPolicyImpact() {
  if (!currentOrganization.value)
    return

  const impact = await organizationStore.checkPasswordPolicyImpact(currentOrganization.value.gid)
  if (impact) {
    affectedMembers.value = impact.nonCompliantUsers.map(u => ({
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
    }))
  }
}

// Handle password policy toggle
async function handlePolicyToggle() {
  if (!hasOrgPerm.value || !currentOrganization.value) {
    toast.error(t('no-permission'))
    policyEnabled.value = !policyEnabled.value // Revert
    return
  }

  if (policyEnabled.value) {
    // Enabling policy - show impact warning
    await checkPasswordPolicyImpact()

    if (affectedMembers.value.length > 0) {
      // Show warning dialog
      dialogStore.openDialog({
        id: 'password-policy-warning',
        title: t('enable-password-policy'),
        description: t('password-policy-impact-warning'),
        size: 'lg',
        buttons: [
          { text: t('button-cancel'), role: 'cancel' },
          { text: t('enable-policy'), role: 'danger', id: 'confirm' },
        ],
      })

      const cancelled = await dialogStore.onDialogDismiss()
      if (cancelled) {
        policyEnabled.value = false
        affectedMembers.value = []
        return
      }
    }
  }

  await updatePasswordPolicy()
}

// Update password policy via Supabase SDK directly
async function updatePasswordPolicy() {
  if (!currentOrganization.value || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  const sanitizedMinLength = Math.min(Math.max(minLength.value, 6), SUPABASE_MAX_PASSWORD_LENGTH)
  minLength.value = sanitizedMinLength

  isSaving.value = true

  const policyConfig = {
    enabled: policyEnabled.value,
    min_length: sanitizedMinLength,
    require_uppercase: requireUppercase.value,
    require_number: requireNumber.value,
    require_special: requireSpecial.value,
  }

  const { error } = await supabase
    .from('orgs')
    .update({ password_policy_config: policyConfig })
    .eq('id', currentOrganization.value.gid)

  isSaving.value = false

  if (error) {
    toast.error(t('failed-to-update-policy'))
    console.error('Failed to update password policy:', error)
    // Reload to revert optimistic updates
    await organizationStore.fetchOrganizations()
    loadPolicyFromOrg()
    return
  }

  toast.success(t('password-policy-updated'))
  await organizationStore.fetchOrganizations()
  affectedMembers.value = []

  // Reload password policy compliance status after policy update
  await loadMembersWithPasswordPolicyStatus()
}

// Update policy when settings change (debounced save)
async function handleSettingChange() {
  if (policyEnabled.value) {
    await updatePasswordPolicy()
  }
}

// Save API key expiration policy
async function saveApikeyPolicy() {
  if (!currentOrganization.value || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  isSaving.value = true

  const { error } = await updateOrganizationSecuritySettings({
    require_apikey_expiration: requireApikeyExpiration.value,
    max_apikey_expiration_days: maxApikeyExpirationDays.value,
  })

  isSaving.value = false

  if (error) {
    toast.error(t('error-saving-settings'))
    console.error('Failed to update API key policy:', error)
    // Reload to revert optimistic updates
    await organizationStore.fetchOrganizations()
    loadApikeyPolicyFromOrg()
    return
  }

  toast.success(t('api-key-policy-updated'))
  await organizationStore.fetchOrganizations()
}

watch(currentOrganization, loadData)

onMounted(async () => {
  await organizationStore.dedupFetchOrganizations()
  await loadData()
})
</script>

<template>
  <div>
    <div class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-lg md:pb-0 max-h-fit grow md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <div class="p-6 space-y-6">
        <h2 class="mb-5 text-2xl font-bold dark:text-white text-slate-800">
          {{ t('security-settings') }}
        </h2>
        <div class="dark:text-gray-100">
          {{ t('security-settings-description') }}
        </div>

        <!-- Loading state -->
        <div v-if="isLoading" class="flex items-center justify-center py-12">
          <Spinner size="w-8 h-8" color="fill-blue-500 text-gray-200 dark:text-gray-600" />
        </div>

        <!-- Content -->
        <template v-else>
          <!-- 2FA Enforcement Section (Combined Toggle + Members Status) -->
          <section class="p-6 border rounded-lg border-slate-200 dark:border-slate-700">
            <!-- 2FA Enforcement Toggle -->
            <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div class="flex items-start gap-4">
                <div class="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/30">
                  <IconShield class="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h3 class="text-lg font-semibold dark:text-white text-slate-800">
                    {{ t('2fa-enforcement-title') }}
                  </h3>
                  <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {{ t('2fa-enforcement-description') }}
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-4">
                <button
                  type="button"
                  :disabled="!hasOrgPerm || isSaving"
                  class="relative inline-flex items-center cursor-pointer"
                  :class="{ 'opacity-50 cursor-not-allowed': !hasOrgPerm || isSaving }"
                  @click="toggle2faEnforcement"
                >
                  <div
                    class="w-11 h-6 rounded-full transition-colors duration-200 ease-in-out"
                    :class="enforcing2fa ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'"
                  >
                    <div
                      class="absolute top-[2px] left-[2px] bg-white border-gray-300 border rounded-full h-5 w-5 transition-transform duration-200 ease-in-out"
                      :class="enforcing2fa ? 'translate-x-full border-white' : ''"
                    />
                  </div>
                </button>
                <span v-if="enforcing2fa" class="px-3 py-1 text-sm font-medium text-green-700 bg-green-100 rounded-full dark:bg-green-900/30 dark:text-green-400">
                  {{ t('enabled') }}
                </span>
                <span v-else class="px-3 py-1 text-sm font-medium text-gray-700 bg-gray-100 rounded-full dark:bg-gray-700 dark:text-gray-300">
                  {{ t('disabled') }}
                </span>
              </div>
            </div>

            <!-- Members 2FA Status Overview -->
            <div v-if="hasOrgPerm" class="mt-6 pt-6 border-t border-slate-200 dark:border-slate-700">
              <h4 class="mb-4 text-base font-semibold dark:text-white text-slate-800">
                {{ t('2fa-members-status') }}
              </h4>

              <!-- Stats cards -->
              <div class="grid grid-cols-1 gap-4 mb-6 md:grid-cols-3">
                <div class="p-4 rounded-lg bg-slate-50 dark:bg-slate-700/50">
                  <div class="flex items-center gap-3">
                    <IconUser class="w-5 h-5 text-slate-500" />
                    <div>
                      <p class="text-2xl font-bold dark:text-white text-slate-800">
                        {{ totalMembersCount }}
                      </p>
                      <p class="text-sm text-slate-600 dark:text-slate-400">
                        {{ t('total-members') }}
                      </p>
                    </div>
                  </div>
                </div>
                <div class="p-4 rounded-lg bg-green-50 dark:bg-green-900/20">
                  <div class="flex items-center gap-3">
                    <IconCheck class="w-5 h-5 text-green-600 dark:text-green-400" />
                    <div>
                      <p class="text-2xl font-bold text-green-700 dark:text-green-400">
                        {{ compliantMembersCount }}
                      </p>
                      <p class="text-sm text-green-600 dark:text-green-500">
                        {{ t('2fa-enabled') }}
                      </p>
                    </div>
                  </div>
                </div>
                <div class="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20">
                  <div class="flex items-center gap-3">
                    <IconWarning class="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    <div>
                      <p class="text-2xl font-bold text-amber-700 dark:text-amber-400">
                        {{ nonCompliantMembersCount }}
                      </p>
                      <p class="text-sm text-amber-600 dark:text-amber-500">
                        {{ t('2fa-not-enabled') }}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Impacted Members List (shown if there are non-compliant members) -->
              <div v-if="impactedMembers.length > 0" class="p-4 border rounded-lg border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20">
                <div class="flex flex-col gap-4 mb-4 md:flex-row md:items-center md:justify-between">
                  <div class="flex items-center gap-2">
                    <IconWarning class="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    <h4 class="font-semibold text-amber-800 dark:text-amber-200">
                      {{ t('2fa-impacted-members-title') }}
                    </h4>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="px-3 py-2 text-xs font-medium text-center border rounded-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 focus:ring-4 focus:ring-amber-300 border-amber-400 dark:border-amber-600 dark:hover:bg-amber-800/30 dark:focus:ring-amber-800 focus:outline-hidden"
                      @click="goToMembersPage()"
                    >
                      {{ t('view') }} {{ t('members') }}
                    </button>
                    <button
                      type="button"
                      class="px-3 py-2 text-xs font-medium text-center border rounded-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 focus:ring-4 focus:ring-amber-300 border-amber-400 dark:border-amber-600 dark:hover:bg-amber-800/30 dark:focus:ring-amber-800 focus:outline-hidden"
                      @click="copyEmailList"
                    >
                      {{ t('copy-email-list') }}
                    </button>
                  </div>
                </div>
                <p class="mb-4 text-sm text-amber-700 dark:text-amber-300">
                  {{ t('2fa-impacted-members-description') }}
                </p>
                <ul class="space-y-2">
                  <li v-for="member in impactedMembers" :key="member.uid" class="flex items-center gap-3 p-2 rounded-lg bg-white/50 dark:bg-slate-800/50">
                    <img
                      v-if="member.image_url"
                      :src="member.image_url"
                      :alt="`Profile picture for ${member.email}`"
                      class="w-8 h-8 rounded-full shrink-0"
                    >
                    <div v-else class="flex items-center justify-center w-8 h-8 text-sm bg-gray-700 rounded-full shrink-0">
                      <span class="font-medium text-gray-300">
                        {{ acronym(member.email) }}
                      </span>
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-medium truncate text-slate-800 dark:text-white">
                        {{ member.email }}
                      </p>
                      <p class="text-xs text-slate-500 dark:text-slate-400">
                        {{ member.role.replace('_', ' ') }}
                      </p>
                    </div>
                  </li>
                </ul>
              </div>

              <!-- All compliant message -->
              <div v-else-if="totalMembersCount > 0" class="p-4 border rounded-lg border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20">
                <div class="flex items-center gap-3">
                  <IconCheck class="w-6 h-6 text-green-600 dark:text-green-400" />
                  <p class="font-medium text-green-700 dark:text-green-300">
                    {{ t('2fa-all-members-compliant') }}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <!-- Encrypted Bundles Enforcement Section -->
          <section class="p-6 border rounded-lg border-slate-200 dark:border-slate-700">
            <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div class="flex items-start gap-4">
                <div class="p-3 rounded-lg bg-purple-50 dark:bg-purple-900/30">
                  <IconLock class="w-6 h-6 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <h3 class="text-lg font-semibold dark:text-white text-slate-800">
                    {{ t('enforce-encrypted-bundles') }}
                  </h3>
                  <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {{ t('enforce-encrypted-bundles-description') }}
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-4">
                <button
                  type="button"
                  :disabled="!hasOrgPerm || isSaving"
                  class="relative inline-flex items-center cursor-pointer"
                  :class="{ 'opacity-50 cursor-not-allowed': !hasOrgPerm || isSaving }"
                  @click="toggleEnforceEncryptedBundles"
                >
                  <div
                    class="w-11 h-6 rounded-full transition-colors duration-200 ease-in-out"
                    :class="enforceEncryptedBundles ? 'bg-purple-600' : 'bg-gray-200 dark:bg-gray-700'"
                  >
                    <div
                      class="absolute top-[2px] left-[2px] bg-white border-gray-300 border rounded-full h-5 w-5 transition-transform duration-200 ease-in-out"
                      :class="enforceEncryptedBundles ? 'translate-x-full border-white' : ''"
                    />
                  </div>
                </button>
                <span v-if="enforceEncryptedBundles" class="px-3 py-1 text-sm font-medium text-purple-700 bg-purple-100 rounded-full dark:bg-purple-900/30 dark:text-purple-400">
                  {{ t('enabled') }}
                </span>
                <span v-else class="px-3 py-1 text-sm font-medium text-gray-700 bg-gray-100 rounded-full dark:bg-gray-700 dark:text-gray-300">
                  {{ t('disabled') }}
                </span>
              </div>
            </div>

            <!-- Required Encryption Key (optional, shown when enforcement is enabled) -->
            <div v-if="enforceEncryptedBundles && hasOrgPerm" class="mt-6 pt-6 border-t border-slate-200 dark:border-slate-700">
              <div class="flex flex-col gap-4">
                <div>
                  <h4 class="mb-2 text-base font-semibold dark:text-white text-slate-800">
                    {{ t('required-encryption-key') }}
                  </h4>
                  <p class="text-sm text-slate-600 dark:text-slate-400">
                    {{ t('required-encryption-key-description') }}
                  </p>
                </div>
                <div class="flex flex-col gap-2 md:flex-row md:items-center">
                  <label for="required-encryption-key" class="sr-only">{{ t('required-encryption-key') }}</label>
                  <input
                    id="required-encryption-key"
                    v-model="requiredEncryptionKey"
                    type="text"
                    maxlength="21"
                    :placeholder="t('required-encryption-key-placeholder')"
                    :aria-label="t('required-encryption-key')"
                    :disabled="isSaving"
                    class="flex-1 px-4 py-2 border rounded-lg font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50"
                  >
                  <button
                    type="button"
                    :disabled="isSaving"
                    class="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 focus:ring-4 focus:ring-purple-300 dark:focus:ring-purple-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    @click="updateRequiredEncryptionKey"
                  >
                    {{ t('save-encryption-key') }}
                  </button>
                </div>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  {{ t('required-encryption-key-help') }}
                </p>
              </div>
            </div>
          </section>

          <!-- Password Policy Section -->
          <section class="p-6 border rounded-lg border-slate-200 dark:border-slate-700">
            <div class="flex items-start gap-4 mb-4">
              <div class="p-3 rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
                <IconFingerprint class="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h3 class="text-lg font-semibold dark:text-white text-slate-800">
                  {{ t('password-policy') }}
                </h3>
                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {{ t('password-policy-description') }}
                </p>
              </div>
            </div>

            <!-- Enable/Disable Toggle -->
            <div class="flex items-center justify-between p-3 mb-4 rounded-lg bg-gray-50 dark:bg-gray-700/50">
              <div>
                <span class="font-medium dark:text-white text-slate-800">{{ t('enforce-password-policy') }}</span>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  {{ t('enforce-password-policy-description') }}
                </p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  id="password-policy-enabled"
                  v-model="policyEnabled"
                  type="checkbox"
                  :aria-label="t('enforce-password-policy')"
                  :disabled="!hasOrgPerm || isSaving"
                  class="sr-only peer"
                  @change="handlePolicyToggle"
                >
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-500 peer-checked:bg-blue-600 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed" />
              </label>
            </div>

            <!-- Policy Configuration (shown when enabled) -->
            <div v-if="policyEnabled" class="pl-4 space-y-4 border-l-2 border-blue-500">
              <!-- Minimum Length -->
              <div class="flex items-center justify-between">
                <label for="password-policy-min-length" class="dark:text-white text-slate-800">{{ t('minimum-length') }}</label>
                <div class="flex items-center space-x-2">
                  <input
                    id="password-policy-min-length"
                    v-model.number="minLength"
                    type="number"
                    min="6"
                    max="72"
                    :aria-label="t('minimum-length')"
                    :disabled="!hasOrgPerm || isSaving"
                    class="w-20 px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50"
                    @change="handleSettingChange"
                  >
                  <span class="text-sm text-gray-500 dark:text-gray-400">{{ t('characters') }}</span>
                </div>
              </div>

              <!-- Require Uppercase -->
              <div class="flex items-center justify-between">
                <label for="password-policy-require-uppercase" class="dark:text-white text-slate-800">{{ t('require-uppercase') }}</label>
                <input
                  id="password-policy-require-uppercase"
                  v-model="requireUppercase"
                  type="checkbox"
                  :aria-label="t('require-uppercase')"
                  :disabled="!hasOrgPerm || isSaving"
                  class="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 dark:bg-gray-700 dark:border-gray-600 disabled:opacity-50"
                  @change="handleSettingChange"
                >
              </div>

              <!-- Require Number -->
              <div class="flex items-center justify-between">
                <label for="password-policy-require-number" class="dark:text-white text-slate-800">{{ t('require-number') }}</label>
                <input
                  id="password-policy-require-number"
                  v-model="requireNumber"
                  type="checkbox"
                  :aria-label="t('require-number')"
                  :disabled="!hasOrgPerm || isSaving"
                  class="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 dark:bg-gray-700 dark:border-gray-600 disabled:opacity-50"
                  @change="handleSettingChange"
                >
              </div>

              <!-- Require Special Character -->
              <div class="flex items-center justify-between">
                <label for="password-policy-require-special" class="dark:text-white text-slate-800">{{ t('require-special-character') }}</label>
                <input
                  id="password-policy-require-special"
                  v-model="requireSpecial"
                  type="checkbox"
                  :aria-label="t('require-special-character')"
                  :disabled="!hasOrgPerm || isSaving"
                  class="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 dark:bg-gray-700 dark:border-gray-600 disabled:opacity-50"
                  @change="handleSettingChange"
                >
              </div>
            </div>
          </section>

          <!-- Password Policy Members Status Overview -->
          <section v-if="hasOrgPerm && policyEnabled" class="p-6 border rounded-lg border-slate-200 dark:border-slate-700">
            <h3 class="mb-4 text-lg font-semibold dark:text-white text-slate-800">
              {{ t('password-policy-members-status') }}
            </h3>

            <!-- Stats cards -->
            <div class="grid grid-cols-1 gap-4 mb-6 md:grid-cols-3">
              <div class="p-4 rounded-lg bg-slate-50 dark:bg-slate-700/50">
                <div class="flex items-center gap-3">
                  <IconUser class="w-5 h-5 text-slate-500" />
                  <div>
                    <p class="text-2xl font-bold dark:text-white text-slate-800">
                      {{ totalPasswordPolicyMembersCount }}
                    </p>
                    <p class="text-sm text-slate-600 dark:text-slate-400">
                      {{ t('total-members') }}
                    </p>
                  </div>
                </div>
              </div>
              <div class="p-4 rounded-lg bg-green-50 dark:bg-green-900/20">
                <div class="flex items-center gap-3">
                  <IconCheck class="w-5 h-5 text-green-600 dark:text-green-400" />
                  <div>
                    <p class="text-2xl font-bold text-green-700 dark:text-green-400">
                      {{ passwordCompliantMembersCount }}
                    </p>
                    <p class="text-sm text-green-600 dark:text-green-500">
                      {{ t('password-policy-compliant') }}
                    </p>
                  </div>
                </div>
              </div>
              <div class="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20">
                <div class="flex items-center gap-3">
                  <IconWarning class="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  <div>
                    <p class="text-2xl font-bold text-amber-700 dark:text-amber-400">
                      {{ passwordNonCompliantMembersCount }}
                    </p>
                    <p class="text-sm text-amber-600 dark:text-amber-500">
                      {{ t('password-policy-non-compliant') }}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <!-- Non-compliant Members List (shown if there are non-compliant members) -->
            <div v-if="nonCompliantPasswordMembers.length > 0" class="p-4 border rounded-lg border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20">
              <div class="flex flex-col gap-4 mb-4 md:flex-row md:items-center md:justify-between">
                <div class="flex items-center gap-2">
                  <IconWarning class="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  <h4 class="font-semibold text-amber-800 dark:text-amber-200">
                    {{ t('password-policy-impacted-members-title') }}
                  </h4>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="px-3 py-2 text-xs font-medium text-center border rounded-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 focus:ring-4 focus:ring-amber-300 border-amber-400 dark:border-amber-600 dark:hover:bg-amber-800/30 dark:focus:ring-amber-800 focus:outline-hidden"
                    @click="goToMembersPage()"
                  >
                    {{ t('view') }} {{ t('members') }}
                  </button>
                  <button
                    type="button"
                    class="px-3 py-2 text-xs font-medium text-center border rounded-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 focus:ring-4 focus:ring-amber-300 border-amber-400 dark:border-amber-600 dark:hover:bg-amber-800/30 dark:focus:ring-amber-800 focus:outline-hidden"
                    @click="copyPasswordPolicyEmailList"
                  >
                    {{ t('copy-email-list') }}
                  </button>
                </div>
              </div>
              <p class="mb-4 text-sm text-amber-700 dark:text-amber-300">
                {{ t('password-policy-impacted-members-description') }}
              </p>
              <ul class="space-y-2">
                <li v-for="member in nonCompliantPasswordMembers" :key="member.uid" class="flex items-center gap-3 p-2 rounded-lg bg-white/50 dark:bg-slate-800/50">
                  <img
                    v-if="member.image_url"
                    :src="member.image_url"
                    :alt="`Profile picture for ${member.email}`"
                    class="w-8 h-8 rounded-full shrink-0"
                  >
                  <div v-else class="flex items-center justify-center w-8 h-8 text-sm bg-gray-700 rounded-full shrink-0">
                    <span class="font-medium text-gray-300">
                      {{ acronym(member.email) }}
                    </span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium truncate text-slate-800 dark:text-white">
                      <span v-if="member.first_name || member.last_name">
                        {{ member.first_name }} {{ member.last_name }} -
                      </span>
                      {{ member.email }}
                    </p>
                    <p class="text-xs text-slate-500 dark:text-slate-400">
                      {{ member.role.replace('_', ' ') }}
                    </p>
                  </div>
                </li>
              </ul>
            </div>

            <!-- All compliant message -->
            <div v-else-if="totalPasswordPolicyMembersCount > 0" class="p-4 border rounded-lg border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20">
              <div class="flex items-center gap-3">
                <IconCheck class="w-6 h-6 text-green-600 dark:text-green-400" />
                <p class="font-medium text-green-700 dark:text-green-300">
                  {{ t('password-policy-all-members-compliant') }}
                </p>
              </div>
            </div>
          </section>

          <!-- API Key Policy Section -->
          <section v-if="hasOrgPerm" class="p-6 border rounded-lg border-slate-200 dark:border-slate-700">
            <div class="flex items-start gap-4 mb-4">
              <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30">
                <IconKey class="w-6 h-6 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 class="text-lg font-semibold dark:text-white text-slate-800">
                  {{ t('api-key-policy') }}
                </h3>
                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {{ t('api-key-policy-description') }}
                </p>
              </div>
            </div>

            <div class="space-y-4">
              <!-- Enforce Secure API Keys toggle -->
              <div class="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50">
                <div>
                  <span class="font-medium dark:text-white text-slate-800">{{ t('enforce-hashed-api-keys') }}</span>
                  <p class="text-sm text-gray-500 dark:text-gray-400">
                    {{ t('enforce-hashed-api-keys-description') }}
                  </p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input
                    id="enforce-hashed-api-keys"
                    type="checkbox"
                    :checked="enforceHashedApiKeys"
                    :aria-label="t('enforce-hashed-api-keys')"
                    :disabled="isSaving"
                    class="sr-only peer"
                    @change="toggleEnforceHashedApiKeys"
                  >
                  <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-amber-300 dark:peer-focus:ring-amber-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-500 peer-checked:bg-amber-600 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed" />
                </label>
              </div>

              <!-- Require API key expiration toggle -->
              <div class="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50">
                <div>
                  <span class="font-medium dark:text-white text-slate-800">{{ t('require-apikey-expiration') }}</span>
                  <p class="text-sm text-gray-500 dark:text-gray-400">
                    {{ t('require-apikey-expiration-description') }}
                  </p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input
                    id="require-apikey-expiration"
                    v-model="requireApikeyExpiration"
                    type="checkbox"
                    :aria-label="t('require-apikey-expiration')"
                    :disabled="isSaving"
                    class="sr-only peer"
                    @change="saveApikeyPolicy"
                  >
                  <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-500 peer-checked:bg-blue-600 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed" />
                </label>
              </div>

              <!-- Max expiration days (shown when require expiration is enabled) -->
              <div v-if="requireApikeyExpiration" class="pl-4 border-l-2 border-blue-500">
                <div class="flex items-center justify-between">
                  <div>
                    <label for="max-apikey-expiration-days" class="dark:text-white text-slate-800">{{ t('max-apikey-expiration-days') }}</label>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                      {{ t('max-apikey-expiration-days-help') }}
                    </p>
                  </div>
                  <input
                    id="max-apikey-expiration-days"
                    v-model.number="maxApikeyExpirationDays"
                    type="number"
                    min="1"
                    max="365"
                    :placeholder="t('max-apikey-expiration-days-placeholder')"
                    :aria-label="t('max-apikey-expiration-days')"
                    :disabled="isSaving"
                    class="w-24 px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50"
                    @change="saveApikeyPolicy"
                  >
                </div>
              </div>
            </div>
          </section>

          <!-- SSO Configuration Section -->
          <section v-if="hasOrgPerm && (isEnterprisePlan || !hideExternalPurchaseFlows)" class="p-6 border rounded-lg border-slate-200 dark:border-slate-700">
            <!-- Enterprise Plan: Show SSO Configuration -->
            <template v-if="isEnterprisePlan">
              <div class="flex items-start gap-4 mb-6">
                <div class="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/30">
                  <IconShield class="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h3 class="text-lg font-semibold dark:text-white text-slate-800">
                    {{ t('sso-configuration') }}
                  </h3>
                  <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {{ t('sso-configuration-description') }}
                  </p>
                </div>
              </div>
              <SsoConfiguration v-if="currentOrganization?.gid" :org-id="currentOrganization.gid" />
            </template>

            <!-- Non-Enterprise Plan: Show Upgrade Prompt -->
            <template v-else>
              <div class="flex items-start gap-4">
                <div class="p-3 rounded-lg bg-slate-100 dark:bg-slate-700/50">
                  <IconShield class="w-6 h-6 text-slate-400 dark:text-slate-500" />
                </div>
                <div class="flex-1">
                  <h3 class="text-lg font-semibold dark:text-white text-slate-800">
                    {{ t('sso-configuration') }}
                  </h3>
                  <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {{ t('sso-enterprise-upgrade-description') }}
                  </p>
                  <div class="mt-4">
                    <button
                      type="button"
                      class="d-btn d-btn-primary d-btn-sm"
                      @click="router.push('/settings/organization/plans')"
                    >
                      {{ t('sso-upgrade-to-enterprise') }}
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </section>

          <!-- Permission notice for non-super-admins -->
          <section v-if="!hasOrgPerm" class="p-4 border rounded-lg border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20">
            <div class="flex items-center gap-3">
              <IconWarning class="w-5 h-5 text-amber-600 dark:text-amber-400" />
              <p class="text-sm text-amber-700 dark:text-amber-300">
                {{ t('security-settings-super-admin-only') }}
              </p>
            </div>
          </section>
        </template>
      </div>
    </div>

    <!-- Teleport for 2FA enforcement warning dialog -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'enforce-2fa-warning'" to="#dialog-v2-content" defer>
      <div class="p-4 mt-4 border rounded-lg border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20">
        <h4 class="mb-3 font-semibold text-amber-800 dark:text-amber-200">
          {{ t('2fa-members-will-be-impacted', { count: impactedMembers.length }) }}
        </h4>
        <p class="mb-4 text-sm text-amber-700 dark:text-amber-300">
          {{ t('2fa-contact-members-before-enabling') }}
        </p>
        <ul class="mb-4 space-y-2">
          <li v-for="member in impactedMembers" :key="member.uid" class="flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <span class="w-2 h-2 rounded-full bg-amber-500" />
            <span class="font-medium">{{ member.email }}</span>
            <span class="text-xs text-amber-600 dark:text-amber-400">({{ member.role.replace('_', ' ') }})</span>
          </li>
        </ul>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-3 py-2 text-xs font-medium text-center border rounded-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 focus:ring-4 focus:ring-amber-300 border-amber-400 dark:border-amber-600 dark:hover:bg-amber-800/30 dark:focus:ring-amber-800 focus:outline-hidden"
            @click="goToMembersPage(true)"
          >
            {{ t('view') }} {{ t('members') }}
          </button>
          <button
            type="button"
            class="px-3 py-2 text-xs font-medium text-center border rounded-lg cursor-pointer text-amber-700 dark:text-amber-300 hover:bg-amber-100 focus:ring-4 focus:ring-amber-300 border-amber-400 dark:border-amber-600 dark:hover:bg-amber-800/30 dark:focus:ring-amber-800 focus:outline-hidden"
            @click="copyEmailList"
          >
            {{ t('copy-email-list') }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Teleport for Password Policy Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'password-policy-warning'" to="#dialog-v2-content" defer>
      <div v-if="affectedMembers.length > 0" class="p-4 mt-4 border border-red-200 rounded-lg bg-red-50 dark:border-red-800 dark:bg-red-900/20">
        <h4 class="mb-3 font-semibold text-red-800 dark:text-red-200">
          {{ t('users-will-be-locked-out') }} ({{ affectedMembers.length }}):
        </h4>
        <ul class="space-y-2 overflow-y-auto max-h-48">
          <li v-for="member in affectedMembers" :key="member.email" class="flex items-center text-red-700 dark:text-red-300">
            <span class="w-2 h-2 mr-3 bg-red-500 rounded-full" />
            <div>
              <span v-if="member.first_name || member.last_name" class="font-medium">
                {{ member.first_name }} {{ member.last_name }}
              </span>
              <span class="text-sm">{{ member.email }}</span>
            </div>
          </li>
        </ul>
        <button
          type="button"
          class="px-3 py-2 mt-4 text-xs font-medium text-center border rounded-lg cursor-pointer text-red-700 dark:text-red-300 hover:bg-red-100 focus:ring-4 focus:ring-red-200 border-red-300 dark:border-red-600 dark:hover:bg-red-900/30 dark:focus:ring-red-900 focus:outline-hidden"
          @click="goToMembersPage(true)"
        >
          {{ t('view') }} {{ t('members') }}
        </button>
        <p class="mt-3 text-sm text-red-600 dark:text-red-400">
          {{ t('users-must-change-password') }}
        </p>
      </div>
    </Teleport>

    <!-- Teleport for Encrypted Bundles Enforcement Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'enforce-encrypted-bundles-warning'" to="#dialog-v2-content" defer>
      <div v-if="nonCompliantBundleCounts" class="p-4 mt-4 border border-red-200 rounded-lg bg-red-50 dark:border-red-800 dark:bg-red-900/20">
        <h4 class="mb-3 font-semibold text-red-800 dark:text-red-200">
          {{ t('bundles-will-be-deleted', { count: nonCompliantBundleCounts.total_non_compliant }) }}
        </h4>
        <ul class="mb-4 space-y-2">
          <li v-if="nonCompliantBundleCounts.non_encrypted_count > 0" class="flex items-center gap-2 text-red-700 dark:text-red-300">
            <span class="w-2 h-2 rounded-full bg-red-500" />
            <span>{{ t('non-encrypted-bundles-count', { count: nonCompliantBundleCounts.non_encrypted_count }) }}</span>
          </li>
          <li v-if="nonCompliantBundleCounts.wrong_key_count > 0" class="flex items-center gap-2 text-red-700 dark:text-red-300">
            <span class="w-2 h-2 rounded-full bg-red-500" />
            <span>{{ t('wrong-key-bundles-count', { count: nonCompliantBundleCounts.wrong_key_count }) }}</span>
          </li>
        </ul>
        <p class="text-sm text-red-600 dark:text-red-400">
          {{ t('bundles-deletion-warning') }}
        </p>
      </div>
    </Teleport>

    <!-- Teleport for Change Encryption Key Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'change-encryption-key-warning'" to="#dialog-v2-content" defer>
      <div v-if="nonCompliantBundleCounts" class="p-4 mt-4 border border-red-200 rounded-lg bg-red-50 dark:border-red-800 dark:bg-red-900/20">
        <h4 class="mb-3 font-semibold text-red-800 dark:text-red-200">
          {{ t('bundles-will-be-deleted-key-change', { count: nonCompliantBundleCounts.wrong_key_count }) }}
        </h4>
        <p class="text-sm text-red-600 dark:text-red-400">
          {{ t('bundles-deletion-key-change-warning') }}
        </p>
      </div>
    </Teleport>
  </div>
</template>

<route lang="yaml">
path: /settings/organization/security
meta:
  layout: settings
</route>

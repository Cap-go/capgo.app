import type { Ref } from 'vue'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Filesystem } from '@capacitor/filesystem'
import { setErrors } from '@formkit/core'
import mime from 'mime'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { createSignedImageUrl } from './storage'
import { useSupabase } from './supabase'

const supabase = useSupabase()
const SIGNED_IMAGE_STORAGE_PATH_REGEX = /\/storage\/v1\/object\/(?:public\/|sign\/)?images\/(.+)$/
const LEADING_SLASHES_REGEX = /^\/+/
const IMAGES_PREFIX_REGEX = /^images\//

function normalizeImageStoragePath(path?: string | null) {
  if (!path)
    return ''

  const pathWithoutQuery = path.split('?')[0]
  const signedUrlMatch = SIGNED_IMAGE_STORAGE_PATH_REGEX.exec(pathWithoutQuery)
  if (signedUrlMatch?.[1])
    return signedUrlMatch[1].replace(LEADING_SLASHES_REGEX, '')

  return pathWithoutQuery.replace(IMAGES_PREFIX_REGEX, '').replace(LEADING_SLASHES_REGEX, '')
}

function getPhotoErrorMessage(error: unknown) {
  if (typeof error === 'string')
    return error
  if (error instanceof Error)
    return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message
  return ''
}

export function isPhotoSelectionCancelledError(error: unknown) {
  const message = getPhotoErrorMessage(error).toLowerCase()
  if (!message)
    return false

  return message.includes('user')
    && /cancel(?:led|ed)/.test(message)
    && /photos?|images?|camera|picker|selection|picking|app/.test(message)
}

function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0
  }
  return bytes.buffer
}

async function uploadPhotoShared(
  data: string,
  storagePath: string,
  contentType: string,
  isLoading: Ref<boolean>,
  callback: (success: boolean, storagePath: string, signedUrl: string) => Promise<void>,
) {
  const { error } = await supabase.storage
    .from('images')
    .upload(storagePath, base64ToArrayBuffer(data), {
      contentType,
    })

  const signedUrl = error ? '' : await createSignedImageUrl(storagePath)

  isLoading.value = false

  if (error || !signedUrl)
    await callback(false, '', '')
  else
    await callback(true, storagePath, signedUrl)
}

async function uploadPhotoUser(formId: string, data: string, fileName: string, contentType: string, isLoading: Ref<boolean>, wentWrong: string) {
  const main = useMainStore()
  const userId = main.user?.id
  if (!userId) {
    setErrors(formId, [wentWrong], {})
    console.error('No user id', userId)
    return
  }
  const safeUserId = userId

  async function userCallback(success: boolean, storagePath: string, signedUrl: string) {
    if (!success) {
      setErrors(formId, [wentWrong], {})
      return
    }

    let previousImagePath = ''
    const { data: currentUser, error: currentUserError } = await supabase
      .from('users')
      .select('image_url')
      .eq('id', safeUserId)
      .maybeSingle()
    if (currentUserError)
      console.error('cannot fetch current user image before update', currentUserError)
    else
      previousImagePath = normalizeImageStoragePath(currentUser?.image_url)

    const { data: usr, error: dbError } = await supabase
      .from('users')
      .update({ image_url: storagePath })
      .eq('id', safeUserId)
      .select()
      .single()

    if (!usr || dbError) {
      setErrors(formId, [wentWrong], {})
      console.error('upload error', dbError)
      const { error: cleanupUploadError } = await supabase
        .storage
        .from('images')
        .remove([storagePath])
      if (cleanupUploadError)
        console.error('cannot cleanup newly uploaded user image after db error', cleanupUploadError)
      return
    }

    if (previousImagePath && previousImagePath !== storagePath) {
      const { error: deletePreviousImageError } = await supabase
        .storage
        .from('images')
        .remove([previousImagePath])
      if (deletePreviousImageError)
        console.error('cannot delete previous user image', deletePreviousImageError)
    }

    usr.image_url = signedUrl
    main.user = usr
  }

  await uploadPhotoShared(data, `${safeUserId}/${fileName}`, contentType, isLoading, userCallback)
}

async function uploadPhotoOrg(formId: string, data: string, fileName: string, contentType: string, isLoading: Ref<boolean>, wentWrong: string) {
  const organizationStore = useOrganizationStore()
  const gid = organizationStore.currentOrganization?.gid
  if (!gid) {
    console.error('No current org id', gid)
    setErrors(formId, [wentWrong], {})
    return
  }
  const safeGid = gid

  async function orgCallback(success: boolean, storagePath: string, _signedUrl: string) {
    if (!success) {
      setErrors(formId, [wentWrong], {})
      return
    }

    const { data: usr, error: dbError } = await supabase
      .from('orgs')
      .update({ logo: storagePath })
      .eq('id', safeGid)
      .select('id')
      .single()

    if (!usr || dbError) {
      setErrors(formId, [wentWrong], {})
      console.error('upload error', dbError)
      return
    }

    await organizationStore.fetchOrganizations()
    organizationStore.setCurrentOrganization(usr.id)
  }

  await uploadPhotoShared(data, `org/${safeGid}/logo/${fileName}`, contentType, isLoading, orgCallback)
}

export async function uploadOrgLogoFile(orgId: string, file: Blob, fileName?: string) {
  const organizationStore = useOrganizationStore()
  const safeOrgId = orgId.trim()
  if (!safeOrgId)
    throw new Error('Organization ID is required')

  const extension = mime.getExtension(file.type) ?? 'png'
  const targetFileName = fileName ?? `${Date.now()}.${extension}`
  const storagePath = `org/${safeOrgId}/logo/${targetFileName}`

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, file, {
      contentType: file.type || undefined,
      upsert: true,
    })

  if (uploadError)
    throw uploadError

  const { data: updatedOrg, error: updateError } = await supabase
    .from('orgs')
    .update({ logo: storagePath })
    .eq('id', safeOrgId)
    .select('id')
    .single()

  if (updateError || !updatedOrg) {
    const { error: cleanupError } = await supabase.storage
      .from('images')
      .remove([storagePath])
    if (cleanupError)
      console.error('cannot cleanup orphaned org logo upload', cleanupError)
    throw updateError ?? new Error('Organization logo update affected no rows')
  }

  try {
    await organizationStore.fetchOrganizations()
  }
  catch (error) {
    console.error('Failed to refresh organizations after org logo upload', error)
  }
  organizationStore.setCurrentOrganization(safeOrgId)

  return storagePath
}

function blobToData(blob: Blob) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}

export async function takePhoto(formId: string, isLoading: Ref<boolean>, type: 'org' | 'user', wentWrong: string) {
  const uploadPhoto = (type === 'user') ? uploadPhotoUser : uploadPhotoOrg
  let cameraPhoto
  try {
    cameraPhoto = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
      quality: 100,
    })
  }
  catch (error) {
    if (!isPhotoSelectionCancelledError(error))
      console.error(error)
    return
  }

  if (!cameraPhoto.dataUrl)
    return

  const contentType = mime.getType(cameraPhoto.format)

  if (!contentType)
    return

  isLoading.value = true
  const fileName = `${Date.now()}.${cameraPhoto.format}`
  try {
    await uploadPhoto(formId, cameraPhoto.dataUrl.split('base64,')[1], fileName, contentType, isLoading, wentWrong)
  }
  catch (e) {
    console.error(e)
    isLoading.value = false
  }
}

export async function pickPhoto(formId: string, isLoading: Ref<boolean>, type: 'org' | 'user', wentWrong: string) {
  const uploadPhoto = (type === 'user') ? uploadPhotoUser : uploadPhotoOrg
  let pickedImages
  try {
    pickedImages = await Camera.pickImages({
      limit: 1,
      quality: 100,
    })
  }
  catch (error) {
    if (!isPhotoSelectionCancelledError(error))
      console.error(error)
    return
  }
  const { photos } = pickedImages
  if (photos.length === 0)
    return
  try {
    let contents
    if (photos[0].path) {
      contents = await Filesystem.readFile({
        path: photos[0].path ?? photos[0].webPath,
      })
    }
    else {
      const blob = await blobToData(await fetch(photos[0].webPath).then(r => r.blob()))
      contents = { data: blob.split('base64,')[1] }
    }
    const contentType = mime.getType(photos[0].format)
    if (!contentType)
      return
    isLoading.value = true
    await uploadPhoto(
      formId,
      contents.data as any,
      `${Date.now()}.${photos[0].format}`,
      contentType,
      isLoading,
      wentWrong,
    )
  }
  catch (e) {
    console.error(e)
    isLoading.value = false
  }
}

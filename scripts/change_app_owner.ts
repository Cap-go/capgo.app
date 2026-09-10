import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
/// <reference lib="deno.ns" />
import { ensureFile } from 'https://deno.land/std/fs/ensure_file.ts'
import { S3Client } from 'https://deno.land/x/s3_lite_client@0.7.0/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js'
import { copyS3LiteObjectIfMatch, isObjectNotFoundError, moveS3LiteObjectToTrash, normalizedS3EtagsMatch } from './r2_trash_utils.ts'

const supabaseUrl = 'https://sb.capgo.app'
const supabaseServiceRole = '***'
const appToTransfer = 'com.demo.app'
const newOwnerEmail = 'admin@capgo.app'

async function main() {
  const S3_BUCKET = 'capgo'
  const rawS3client = new S3Client({
    endPoint: '9ee3d7479a3c359681e3fab2c8cb22c0.r2.cloudflarestorage.com',
    useSSL: true,
    region: 'auto',
    accessKey: '***',
    secretKey: '***',
    bucket: S3_BUCKET,
  })
  const supabase = createClient<Database>(supabaseUrl, supabaseServiceRole, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  const { data: oldUser, error: error1 } = await supabase.from('apps')
    .select('*')
    .eq('app_id', appToTransfer)
    .single()

  if (error1)
    throw error1

  const { data: newUser, error: error2 } = await supabase.from('users')
    .select('*')
    .eq('email', newOwnerEmail)
    .single()

  if (error2)
    throw error1

  const oldUserId = oldUser.user_id as string
  const newUserId = newUser.id as string

  console.log(`old id: ${JSON.stringify(oldUserId)}`)
  console.log(`new id: ${JSON.stringify(newUserId)}`)

  console.log('tmp dir: /tmp/move-tmp')
  try {
    await Deno.mkdir('/tmp/move-tmp')
  }
  catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists))
      throw err
  }

  console.log(`Listing objects for ${oldUserId}`)
  for await (const obj of rawS3client.listObjects({ prefix: `apps/${oldUserId}/` })) {
    console.log(`Processing ${obj.key}`)
    const getObj = await rawS3client.getObject(obj.key)
    await ensureFile(`/tmp/move-tmp/${obj.key}`)
    const file = await Deno.create(`/tmp/move-tmp/${obj.key}`)
    await getObj.body?.pipeTo(file.writable)

    const sourceStat = await rawS3client.statObject(obj.key)
    const discoveryEtag = sourceStat.etag
    const discoveryLastModified = sourceStat.lastModified
    if (!discoveryEtag)
      throw new Error(`Missing source ETag for ${obj.key}; aborting transfer`)
    if (!discoveryLastModified)
      throw new Error(`Missing source Last-Modified for ${obj.key}; aborting transfer`)

    const destinationKey = obj.key.replace(oldUserId, newUserId)
    try {
      const destinationStat = await rawS3client.statObject(destinationKey)
      if (!normalizedS3EtagsMatch(destinationStat.etag, discoveryEtag))
        throw new Error(`Destination ${destinationKey} already exists with different content; aborting transfer`)
    }
    catch (error) {
      if (!isObjectNotFoundError(error))
        throw error
    }
    await copyS3LiteObjectIfMatch(rawS3client, obj.key, destinationKey, discoveryEtag, S3_BUCKET, discoveryLastModified)
    const trashResult = await moveS3LiteObjectToTrash(rawS3client, obj.key, S3_BUCKET, discoveryEtag, discoveryLastModified)
    if (trashResult === 'moved' || trashResult === 'skipped_missing')
      continue

    if (trashResult === 'skipped_changed') {
      const retryResult = await moveS3LiteObjectToTrash(rawS3client, obj.key, S3_BUCKET)
      if (retryResult === 'moved' || retryResult === 'skipped_missing')
        continue

      let sourceExists = true
      try {
        await rawS3client.statObject(obj.key)
      }
      catch (error) {
        if (isObjectNotFoundError(error))
          sourceExists = false
        else
          throw error
      }

      let destinationMatches = false
      try {
        const destinationStat = await rawS3client.statObject(destinationKey)
        destinationMatches = normalizedS3EtagsMatch(destinationStat.etag, discoveryEtag)
      }
      catch (error) {
        if (!isObjectNotFoundError(error))
          throw error
      }

      if (!sourceExists && destinationMatches)
        continue

      throw new Error(`Copied ${obj.key} to ${destinationKey} but failed to trash source object (${retryResult})`)
    }

    throw new Error(`Copied ${obj.key} to new owner key but failed to trash source object (${trashResult})`)
  }

  console.log('Updating user_id in apps')
  const { error: error3 } = await supabase.from('apps')
    .update({ user_id: newUserId })
    .eq('user_id', oldUserId)

  if (error3)
    throw error3

  console.log('Updating user_id in app_versions')
  const { error: error4 } = await supabase.from('app_versions')
    .update({ user_id: newUserId })
    .eq('app_id', appToTransfer)

  if (error4)
    throw error4

  console.log('Updating user_id in app_versions_meta')
  const { error: error5 } = await supabase.from('app_versions_meta')
    .update({ user_id: newUserId })
    .eq('app_id', appToTransfer)

  if (error5)
    throw error5

  console.log('Updating user_id in channel_devices')
  const { error: error6 } = await supabase.from('channel_devices')
    .update({ created_by: newUserId })
    .eq('app_id', appToTransfer)

  if (error6)
    throw error6

  console.log('Updating user_id in channels')
  const { error: error7 } = await supabase.from('channels')
    .update({ created_by: newUserId })
    .eq('app_id', appToTransfer)

  if (error7)
    console.log(JSON.stringify(error7))

  console.log('Updating user_id in devices_override')
  const { error: error8 } = await supabase.from('devices_override')
    .update({ created_by: newUserId })
    .eq('app_id', appToTransfer)

  if (error8)
    console.log(JSON.stringify(error8))
}

await main()

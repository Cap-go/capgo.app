/* eslint-disable node/prefer-global/process */
import type { _Object, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'// supabase.types.ts'
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'
import { ConcurrencyLimiter, encodeS3CopySource, getR2TrashKey, isAlreadyMovedToTrash, isLiveR2Key, isObjectNotFoundError, isPreconditionFailedError, resolveOpsDeleteMode } from './r2_trash_utils.ts'

const S3_BUCKET = 'capgo'
const MAGIC_TO_DELETE = './tmp/magic_to_delete6.txt'
const DELETE_CONCURRENCY = 20

async function main() {
  if (process.env.MAKE_COPY === '1') {
    const s3 = await initS3()
    const files = JSON.parse(await Bun.file('./tmp/filtr.txt'/* MAGIC_TO_DELETE */).text()) as _Object[]
    const file = files[0]
    console.log({
      Bucket: 'capgo-cleanup-backup',
      CopySource: `${S3_BUCKET}/${file.Key}`,
      Key: file.Key,
    })
    // try {
    //   const com = new CopyObjectCommand({
    //     Bucket: ('backuptmp'),
    //     CopySource: (`${S3_BUCKET}/${file.Key}`),
    //     Key: (file.Key ?? ''),
    //     // ACL: 'authenticated-read',
    //   })
    //   console.log(com)
    //   await s3.send(com)
    // }
    // catch (e) {
    //   console.log(e)
    // }

    const promises = files.map((file) => {
      const com = new CopyObjectCommand({
        Bucket: ('backuptmp'),
        CopySource: (`${S3_BUCKET}/${file.Key}`),
        Key: (file.Key ?? ''),
        // ACL: 'authenticated-read',
      })
      return s3.send(com)
    })
    await Promise.all(promises)
    return
  }
  else if (process.env.LIST_FILES === '1') {
    // 10250
    const s3 = await initS3()
    const files = await listAllObjectsInFolder(s3, null as any, 'backuptmp')
    console.log(files.length)
    const allFiles = JSON.parse(await Bun.file(MAGIC_TO_DELETE).text()) as _Object[]
    const filesMap = new Map(files.map(f => [f.Key ?? 'a', f]))
    const filter = allFiles.filter(f => !filesMap.get(f.Key ?? ''))
    const str = JSON.stringify(filter, null, 2)
    await Bun.write('./tmp/filtr.txt', str)
    return
  }

  else if (process.env.DELETE_FILES === '1') {
    const deleteMode = resolveOpsDeleteMode({
      DRY_RUN: process.env.DRY_RUN,
      ALLOW_PERMANENT_R2_DELETE: process.env.ALLOW_PERMANENT_R2_DELETE,
    })
    const files = JSON.parse(await Bun.file(MAGIC_TO_DELETE).text()) as _Object[]
    const keys = files.map(file => file.Key ?? '').filter(key => key && isLiveR2Key(key))
    let errorCount = 0

    if (deleteMode === 'dry_run') {
      console.log(`DELETE_FILES=1 dry-run: would process ${keys.length} live objects`)
      for (const key of keys)
        console.log(`Would process: ${key}`)
      return
    }

    const s3 = await initS3()

    if (deleteMode === 'permanent')
      console.warn('WARNING: ALLOW_PERMANENT_R2_DELETE=true — permanently deleting objects')
    else
      console.warn('DELETE_FILES=1: moving objects to 7-day trash (set ALLOW_PERMANENT_R2_DELETE=true for permanent delete)')

    const limiter = new ConcurrencyLimiter(DELETE_CONCURRENCY)

    async function objectExists(key: string): Promise<boolean> {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
        return true
      }
      catch (error) {
        if (isObjectNotFoundError(error))
          return false
        throw error
      }
    }

    async function moveKeyToTrash(key: string): Promise<'ok' | 'skipped' | 'failed'> {
      const trashKey = getR2TrashKey(key)
      let sourceEtag: string | undefined
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
        sourceEtag = head.ETag
      }
      catch (headError) {
        if (isObjectNotFoundError(headError))
          return 'skipped'
        console.error(`Failed to head ${key} before trash:`, headError)
        return 'failed'
      }

      try {
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: encodeS3CopySource(S3_BUCKET, key),
          Key: trashKey,
        }))
      }
      catch (copyError) {
        try {
          const trashExists = await objectExists(trashKey)
          const sourceExists = await objectExists(key)
          if (isAlreadyMovedToTrash(trashExists, sourceExists))
            return 'skipped'
        }
        catch (headError) {
          console.error(`Failed to verify trash resume state for ${key}:`, headError)
          return 'failed'
        }
        console.error(`Failed to trash ${key}:`, copyError)
        return 'failed'
      }

      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          IfMatch: sourceEtag,
        }))
        return 'ok'
      }
      catch (deleteError) {
        if (isPreconditionFailedError(deleteError)) {
          console.warn(`Skipped delete for ${key}: live object changed after copy (possible concurrent upload)`)
          return 'skipped'
        }
        console.error(`Copied ${key} to trash but failed to delete source:`, deleteError)
        return 'failed'
      }
    }

    if (deleteMode === 'permanent') {
      const toDelete = keys.map(key => ({ Key: key }))
      while (toDelete.length > 0) {
        const chunk = toDelete.splice(0, 999)
        console.log('permanent delete batch')
        try {
          const response = await s3.send(new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: chunk },
          }))
          const batchErrors = response.Errors ?? []
          if (batchErrors.length > 0) {
            console.error('Failed to permanently delete objects:', batchErrors)
            errorCount += batchErrors.length
          }
        }
        catch (error) {
          console.error('Failed to permanently delete batch:', error)
          errorCount += chunk.length
        }
      }
    }
    else {
      for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
        const batch = keys.slice(i, i + DELETE_CONCURRENCY)
        const results = await Promise.all(batch.map(key => limiter.run(() => moveKeyToTrash(key))))
        errorCount += results.filter(result => result === 'failed').length
      }
    }

    if (errorCount > 0)
      process.exit(1)
    return
  }

  const s3 = await initS3()
  const supabase = supabaseAdmin()
  const list = await listAllObjectsInFolder(s3, 'apps/')
  // await s3.send(new ListObjectsV2Command({
  //   Bucket: S3_BUCKET,
  //   Prefix: 'apps/',
  // }))

  const notFoundObjects = [] as _Object[]
  if (list) {
    console.log(`found ${list.length} objects to analyze`)
    const promises = [] as Promise<null>[]
    for (let i = 0; i < (list.length ?? 0); i++) {
      const item = list[i]
      if (item.Key === null) {
        throw new Error(`item: ${item} has a null key???`)
      }
      const itemPath = item.Key!.split('/')
      if (itemPath.length !== 5) {
        throw new Error(`item: ${item} length is not enough`)
      }
      // const appUuid = itemPath[1]
      const appId = itemPath[2]
      const versionName = itemPath[4].split('.zip').at(0) ?? ''

      async function checkSupabase() {
        const { data: version, error: errorVer } = await supabase
          .from('app_versions')
          .select('*')
          .eq('app_id', appId)
          .eq('name', versionName)
          .single()

        if (errorVer || version.deleted) {
          // console.error(`Cannot find version for ${JSON.stringify(item)}. Error: ${JSON.stringify(errorVer)}`)
          notFoundObjects.push(item)
        }
        return null
      }

      promises.push(checkSupabase())
    }
    const allS3Orgs = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'orgs/',
      Delimiter: '/',
    })) as ListObjectsV2CommandOutput
    if (allS3Orgs.CommonPrefixes) {
      for (let i = 0; i < (allS3Orgs.CommonPrefixes.length ?? 0); i++) {
        const prefix = allS3Orgs.CommonPrefixes[i].Prefix
        if (prefix === null) {
          throw new Error(`A null prefix?`)
        }
        async function handleOrg() {
          const files = await listAllObjectsInFolder(s3, prefix!)
          console.log(`found ${files.length} items to analyze for analyze for org id ${i}`)
          for (let j = 0; j < (files.length ?? 0); j++) {
            const item = files[j]
            if (item.Key === null) {
              throw new Error(`item: ${item} has a null key???`)
            }

            const itemPath = item.Key!.split('/')
            const finalItem = itemPath.at(-1)
            if (finalItem && finalItem.endsWith('.zip')) {
              const { data: version, error: errorVer } = await supabase
                .from('app_versions')
                .select('*')
                .eq('r2_path', item.Key!)
                .single()

              if (errorVer || version.deleted) {
                console.log(errorVer)
                // console.error(`Cannot find version for ${JSON.stringify(item)}. Error: ${JSON.stringify(errorVer)}`)
                notFoundObjects.push(item)
              }
            }
          }
          return null
        }
        promises.push(handleOrg())
      }
    }
    // await listAllObjectsInFolder(s3, 'orgs/')

    const handled = 0
    // if (list2) {
    //   console.log(`found ${list2.length} items to analyze for second list`)
    //   // const promises = [] as Promise<null>[]
    //   for (let i = 0; i < (list.length ?? 0); i++) {
    //     const item = list[i]
    //     if (item.Key === null) {
    //       throw new Error(`item: ${item} has a null key???`)
    //     }

    //     const itemPath = item.Key!.split('/')
    //     const finalItem = itemPath.at(-1)
    //     if (finalItem && finalItem.endsWith('.zip') && semver.canParse(finalItem.slice(0, -4))) {
    //       handled += 1

    //       async function checkSupabase() {
    //         const { data: version, error: errorVer } = await supabase
    //           .from('app_versions')
    //           .select('*')
    //           .eq('r2_path', itemPath)
    //           .single()

    //         if (errorVer || version.deleted) {
    //           // console.error(`Cannot find version for ${JSON.stringify(item)}. Error: ${JSON.stringify(errorVer)}`)
    //           notFoundObjects.push(item)
    //         }
    //         return null
    //       }
    //       promises.push(checkSupabase())
    //     }
    //   }
    //   console.log(`han: ${handled}; total: ${list2.length}`)
    // }

    console.log('total promises:', promises.length)
    await Promise.all(promises)
    console.log(`Not found items: ${notFoundObjects.length}; Total items: ${list.length + handled}`)
    const str = JSON.stringify(notFoundObjects, null, 2)
    await Bun.write(MAGIC_TO_DELETE, str)
    // console.log(notFoundObjects)
  }

  // console.log(list)
  // console.log(`${process.env.S3_ACCESS_KEY_ID}`)
}

function getEnv(s: string) {
  return process.env[s] ?? ''
}

async function listAllObjectsInFolder(s3: S3Client, path: string, bucketName: string | null = null) {
  const folderPrefix = path

  let continuationToken: string | null = null
  let object = [] as _Object[]

  try {
    while (true) {
      const data = await s3.send(new ListObjectsV2Command({
        Bucket: bucketName ?? S3_BUCKET,
        Prefix: folderPrefix,
        ContinuationToken: continuationToken || undefined,
      })) as ListObjectsV2CommandOutput

      console.log(data.NextContinuationToken, data.IsTruncated)
      continuationToken = data.NextContinuationToken ?? ''
      object = object.concat(data.Contents ?? [])
      if (data.IsTruncated != null && data.IsTruncated === false) {
        break
      }
    }
  }
  catch (err) {
    console.error('Error listing objects', err)

    process.exit(1)
  }
  return object
}

export function supabaseAdmin() {
  const c = null
  const options = {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
  return createClient<Database>(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), options)
}

export function initS3() {
  const c = null
  const access_key_id = getEnv('S3_BACKUP_1')
  const access_key_secret = getEnv('S3_BACKUP_2')
  const storageEndpoint = getEnv('S3_ENDPOINT')
  const useSsl = getEnv('S3_SSL') !== 'false'

  const storageRegion = getEnv('S3_REGION')
  const params = {
    credentials: {
      accessKeyId: access_key_id,
      secretAccessKey: access_key_secret,
    },
    endpoint: `${useSsl ? 'https' : 'http'}://${storageEndpoint}`,
    region: storageRegion ?? 'us-east-1',
    // not apply in supabase local
    forcePathStyle: true, // storageEndpoint !== '127.0.0.1:54321/storage/v1/s3',
    signingEscapePath: false,
    // signingEscapePath: storageEndpoint !== '127.0.0.1:54321/storage/v1/s3',
  }

  console.log({
    message: 'initS3',
    params: {
      ...params,
      credentials: {
        accessKeyId: '[redacted]',
        secretAccessKey: '[redacted]',
      },
    },
  })

  return new S3Client({ ...params })
}

await main()

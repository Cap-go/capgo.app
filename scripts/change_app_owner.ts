/// <reference lib="deno.ns" />
import { ensureFile } from 'https://deno.land/std/fs/ensure_file.ts'
import { S3Client } from 'https://deno.land/x/s3_lite_client@0.7.0/mod.ts'
import pg from 'npm:pg@8'

const databaseUrl = '***'
const appToTransfer = 'com.demo.app'
const newOwnerEmail = 'admin@capgo.app'

async function main() {
  const s3client = new S3Client({
    endPoint: '9ee3d7479a3c359681e3fab2c8cb22c0.r2.cloudflarestorage.com',
    useSSL: true,
    region: 'auto',
    accessKey: '***',
    secretKey: '***',
    bucket: 'capgo',
  })

  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()

  const { rows: oldUsers } = await db.query('SELECT * FROM public.apps WHERE app_id = $1', [appToTransfer])
  if (oldUsers.length !== 1)
    throw new Error(`Expected 1 app ${appToTransfer}, got ${oldUsers.length}`)
  const oldUser = oldUsers[0]

  const { rows: newUsers } = await db.query('SELECT * FROM public.users WHERE email = $1', [newOwnerEmail])
  if (newUsers.length !== 1)
    throw new Error(`Expected 1 user ${newOwnerEmail}, got ${newUsers.length}`)
  const newUser = newUsers[0]

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
  for await (const obj of s3client.listObjects({ prefix: `apps/${oldUserId}/` })) {
    console.log(`Processing ${obj.key}`)
    const getObj = await s3client.getObject(obj.key)
    await ensureFile(`/tmp/move-tmp/${obj.key}`)
    const file = await Deno.create(`/tmp/move-tmp/${obj.key}`)
    await getObj.body?.pipeTo(file.writable)

    await s3client.copyObject({ sourceKey: obj.key }, obj.key.replace(oldUserId, newUserId))
    await s3client.deleteObject(obj.key)
  }

  console.log('Updating user_id in apps')
  await db.query('UPDATE public.apps SET user_id = $1 WHERE user_id = $2', [newUserId, oldUserId])

  console.log('Updating user_id in app_versions')
  await db.query('UPDATE public.app_versions SET user_id = $1 WHERE app_id = $2', [newUserId, appToTransfer])

  console.log('Updating user_id in app_versions_meta')
  await db.query('UPDATE public.app_versions_meta SET user_id = $1 WHERE app_id = $2', [newUserId, appToTransfer])

  console.log('Updating user_id in channel_devices')
  await db.query('UPDATE public.channel_devices SET created_by = $1 WHERE app_id = $2', [newUserId, appToTransfer])

  console.log('Updating user_id in channels')
  await db.query('UPDATE public.channels SET created_by = $1 WHERE app_id = $2', [newUserId, appToTransfer])
    .catch((error: unknown) => console.log(JSON.stringify(error)))

  console.log('Updating user_id in devices_override')
  await db.query('UPDATE public.devices_override SET created_by = $1 WHERE app_id = $2', [newUserId, appToTransfer])
    .catch((error: unknown) => console.log(JSON.stringify(error)))

  await db.end()
}

await main()

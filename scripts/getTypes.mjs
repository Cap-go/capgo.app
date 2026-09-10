import { execFile as execFileCb } from 'node:child_process'
import { writeFile, copyFile, readFile } from 'node:fs/promises'
import util from 'node:util'
import { supa_url } from './utils.mjs'

const execFile = util.promisify(execFileCb)

async function getLinkedProjectRef() {
  try {
    return (await readFile('supabase/.temp/project-ref', 'utf8')).trim()
  }
  catch {
    return ''
  }
}

async function getTypeGenTarget() {
  const configuredUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPA_URL || supa_url
  const branch = process.env.BRANCH || process.env.ENV

  if (branch === 'local')
    return ['--local']

  let hostname = ''
  try {
    hostname = new URL(configuredUrl).hostname
  }
  catch {
    throw new Error(`Invalid Supabase URL: ${configuredUrl}`)
  }

  if (['localhost', '127.0.0.1'].includes(hostname))
    return ['--local']

  const explicitProjectRef = process.env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_ID
  if (explicitProjectRef)
    return [`--project-id=${explicitProjectRef}`]

  const linkedProjectRef = await getLinkedProjectRef()
  if (linkedProjectRef)
    return [`--project-id=${linkedProjectRef}`]

  if (hostname.endsWith('.supabase.co'))
    return [`--project-id=${hostname.split('.')[0]}`]

  throw new Error(
    `Unable to resolve Supabase project ref from ${configuredUrl}. Set SUPABASE_PROJECT_REF (or SUPABASE_PROJECT_ID) in the environment.`,
  )
}

export async function main() {
  const args = ['supabase', 'gen', 'types', 'typescript', ...await getTypeGenTarget()]
  const { stdout, stderr } = await execFile('bunx', args)
  await writeFile('src/types/supabase.types.ts', stdout)
  if (stderr)
    console.error(stderr)
  else
    console.log('Type generated ✅')

  await copyFile('src/types/supabase.types.ts', 'supabase/functions/_backend/utils/supabase.types.ts')
  console.log('Copy done ✅')
}

if (import.meta.main)
  await main()

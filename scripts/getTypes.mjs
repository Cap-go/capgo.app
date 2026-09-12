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

/**
 * @typedef {object} TypeGenerationDependencies
 * @property {(source: string, destination: string) => Promise<void>} [copy]
 * @property {(file: string, args: string[]) => Promise<{ stdout: string, stderr: string }>} [execute]
 * @property {() => Promise<string[]>} [resolveTarget]
 * @property {(file: string, contents: string) => Promise<void>} [write]
 */

/** @param {TypeGenerationDependencies} [dependencies] */
export async function generateTypes(dependencies = {}) {
  const {
    copy = copyFile,
    execute = execFile,
    resolveTarget = getTypeGenTarget,
    write = writeFile,
  } = dependencies
  const args = ['supabase', 'gen', 'types', 'typescript', ...await resolveTarget()]
  const { stdout, stderr } = await execute('bunx', args)
  await write('src/types/supabase.types.ts', stdout)
  if (stderr)
    console.error(stderr)
  else
    console.log('Type generated ✅')

  await copy('src/types/supabase.types.ts', 'supabase/functions/_backend/utils/supabase.types.ts')
  console.log('Copy done ✅')
}

if (import.meta.main)
  await generateTypes()

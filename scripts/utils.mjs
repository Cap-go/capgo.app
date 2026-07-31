import { env } from 'node:process'
import { config } from 'dotenv'
import keys from '../configs.json'

config()

export const branch = env.ENV || env.BRANCH || 'main'
console.log('Branch', branch)

export function getRightKey(keyname) {
  // console.log('getRightKey', branch, keyname)
  // Check for environment variable first (uppercase version)
  // Use env var if it's defined (even if empty string)
  const envVarName = keyname.toUpperCase()
  if (envVarName in env)
    return env[envVarName]

  if (!keys || !keys[keyname])
    return ''
  if (branch === 'alpha')
    return keys[keyname].development
  else if (branch === 'local')
    return keys[keyname].local
  else if (branch in keys[keyname])
    return keys[keyname][branch]
  return keys[keyname].prod
}
export const supa_url = getRightKey('supa_url')
export const supa_anon = getRightKey('supa_anon')

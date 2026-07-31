import type { Router } from 'vue-router'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { toast } from 'vue-sonner'
import { getSpoofedAdminJwt, isSpoofed, saveSpoof, useSupabase } from './supabase'

async function getErrorMessage(error: unknown) {
  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    try {
      const json = await error.context.clone().json() as { error?: string, message?: string }
      if (json.message)
        return json.message
      if (json.error)
        return json.error
    }
    catch {
      // Fall back to the SDK error message below.
    }
  }

  if (error instanceof Error)
    return error.message
  if (typeof error === 'string')
    return error
  const message = typeof error === 'object' && error !== null
    ? (error as { message?: unknown }).message
    : undefined
  if (typeof message === 'string')
    return message
  return 'Cannot log in, see console'
}

export async function logAsUser(identifier: string, router: Router) {
  const toastId = toast.loading('Logging as...')
  try {
    if (!identifier)
      throw new Error('Missing user id, email, or org id')

    const wasSpoofed = isSpoofed()
    const spoofedAdminJwt = wasSpoofed ? await getSpoofedAdminJwt() : null
    if (wasSpoofed && !spoofedAdminJwt)
      throw new Error('Cannot restore admin session, please sign in again')

    const supabase = useSupabase()
    const invokeOptions: { body: { identifier: string }, headers?: Record<string, string> } = {
      body: { identifier },
    }
    if (spoofedAdminJwt)
      invokeOptions.headers = { Authorization: `Bearer ${spoofedAdminJwt}` }

    const { data, error } = await supabase.functions.invoke('private/log_as', invokeOptions)

    if (error)
      throw new Error(await getErrorMessage(error))

    const { jwt: newJwt, refreshToken: newRefreshToken } = data ?? {}

    if (!newJwt || !newRefreshToken)
      throw new Error('Cannot log in, see console')

    let adminSession: { jwt: string, refreshToken: string } | null = null
    if (!wasSpoofed) {
      const { data: currentSession, error: sessionError } = await supabase.auth.getSession()
      if (sessionError || !currentSession?.session)
        throw new Error('No current session')

      const { access_token: currentJwt, refresh_token: currentRefreshToken } = currentSession.session
      adminSession = { jwt: currentJwt, refreshToken: currentRefreshToken }
    }

    const { error: authError } = await supabase.auth.setSession({ access_token: newJwt, refresh_token: newRefreshToken })
    if (authError)
      throw authError

    if (adminSession)
      saveSpoof(adminSession.jwt, adminSession.refreshToken)

    toast.dismiss(toastId)
    toast.success('Spoofed, will reload')
    setTimeout(() => {
      router.replace('/dashboard').then(() => {
        globalThis.location.reload()
      })
    }, 1000)
  }
  catch (error) {
    toast.dismiss(toastId)
    const message = await getErrorMessage(error)
    toast.error(message)
    console.error(error)
    throw error
  }
}

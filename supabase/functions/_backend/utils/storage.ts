import type { Context } from 'hono'
import { supabaseAdmin } from './supabase.ts'

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const STORAGE_URL_REGEX = /\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/(.+)$/

export function normalizeImagePath(raw?: string | null) {
  if (!raw)
    return null

  const trimmed = raw.trim()
  if (!trimmed)
    return null

  try {
    const url = new URL(trimmed)
    const match = STORAGE_URL_REGEX.exec(url.pathname)
    if (match?.[1])
      return decodeURIComponent(match[1])
    return trimmed
  }
  catch {
    // Not a URL
  }

  return trimmed.replace(/^images\//, '').replace(/^\/+/, '')
}

export async function createSignedImageUrl(c: Context, rawPath?: string | null) {
  if (!rawPath)
    return null

  if (rawPath.includes('://'))
    return rawPath

  const normalized = normalizeImagePath(rawPath)
  if (!normalized)
    return null

  const { data, error } = await supabaseAdmin(c)
    .storage
    .from('images')
    .createSignedUrl(normalized, SIGNED_URL_TTL_SECONDS)

  if (error || !data?.signedUrl)
    return null

  return data.signedUrl
}

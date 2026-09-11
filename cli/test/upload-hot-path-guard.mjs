export const SUPABASE_RPC_PATTERN = /\bsupabase(?:\s*\?)?\s*\.\s*rpc\s*\(/
export const SUPABASE_FROM_PATTERN = /\bsupabase(?:\s*\?)?\s*\.\s*from\s*\(/
export const FUNCTIONS_INVOKE_PATTERN = /\bfunctions(?:\s*\?)?\s*\.\s*invoke\s*\(/

export function sliceUploadHotPath(uploadSource) {
  const autoBumpStart = uploadSource.indexOf('const autoBumpInput = normalizeAutoBumpInput')
  const autoBumpEnd = uploadSource.indexOf('if (options.autoSetBundle)', autoBumpStart)
  if (autoBumpStart === -1)
    throw new Error('upload.ts auto-bump marker missing: const autoBumpInput = normalizeAutoBumpInput')
  if (autoBumpEnd === -1)
    throw new Error('upload.ts auto-bump marker missing: if (options.autoSetBundle)')
  return `${uploadSource.slice(0, autoBumpStart)}${uploadSource.slice(autoBumpEnd)}`
}

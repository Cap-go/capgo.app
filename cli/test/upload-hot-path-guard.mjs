export function sliceUploadHotPath(uploadSource) {
  const autoBumpStart = uploadSource.indexOf('const autoBumpInput = normalizeAutoBumpInput')
  const autoBumpEnd = uploadSource.indexOf('if (options.autoSetBundle)', autoBumpStart)
  if (autoBumpStart === -1)
    throw new Error('upload.ts auto-bump marker missing: const autoBumpInput = normalizeAutoBumpInput')
  if (autoBumpEnd === -1)
    throw new Error('upload.ts auto-bump marker missing: if (options.autoSetBundle)')
  return `${uploadSource.slice(0, autoBumpStart)}${uploadSource.slice(autoBumpEnd)}`
}

export function getCanonicalAppVersionR2Path(
  ownerOrg: string,
  appId: string,
  versionName: string,
): string {
  return `orgs/${ownerOrg}/apps/${appId}/${versionName}.zip`
}

export function isVersionScopedAppVersionR2Path(
  r2Path: string,
  appId: string,
  versionName: string,
): boolean {
  const expectedSuffix = `/apps/${appId}/${versionName}.zip`
  if (!r2Path.startsWith('orgs/') || !r2Path.endsWith(expectedSuffix))
    return false

  const ownerOrgSegment = r2Path.slice('orgs/'.length, r2Path.length - expectedSuffix.length)
  return ownerOrgSegment.length > 0 && !ownerOrgSegment.includes('/')
}

export function isCanonicalAppVersionR2Path(record: {
  owner_org?: string | null
  app_id?: string | null
  name?: string | null
  r2_path?: string | null
}): boolean {
  if (!record.r2_path)
    return false

  const ownerOrg = record.owner_org
  const appId = record.app_id
  const versionName = record.name
  if (!appId || !versionName)
    return false

  if (ownerOrg && record.r2_path === getCanonicalAppVersionR2Path(ownerOrg, appId, versionName))
    return true

  return isVersionScopedAppVersionR2Path(record.r2_path, appId, versionName)
}

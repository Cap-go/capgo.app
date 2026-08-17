export function getCanonicalAppVersionR2Path(
  ownerOrg: string,
  appId: string,
  versionName: string,
): string {
  return `orgs/${ownerOrg}/apps/${appId}/${versionName}.zip`
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
  if (!ownerOrg || !appId || !versionName)
    return false

  return record.r2_path === getCanonicalAppVersionR2Path(ownerOrg, appId, versionName)
}

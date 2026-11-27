export function rotateMcpFailureSpikeGroups<T>(groups: readonly T[], startOffset: number): T[] {
  if (groups.length === 0)
    return []
  const normalized = ((startOffset % groups.length) + groups.length) % groups.length
  return [...groups.slice(normalized), ...groups.slice(0, normalized)]
}

export function advanceMcpFailureSpikeGroupCursor(
  cursor: number,
  processedGroupCount: number,
  groupCount: number,
): number {
  if (groupCount <= 0)
    return 0
  return (cursor + processedGroupCount) % groupCount
}
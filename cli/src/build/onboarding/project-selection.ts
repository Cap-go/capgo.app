import type { CapacitorProjectCandidate } from './project-discovery.js'

export interface BuilderProjectPrompts {
  confirm: (candidate: CapacitorProjectCandidate) => Promise<boolean | symbol>
  select: (candidates: CapacitorProjectCandidate[]) => Promise<string | symbol>
}

export async function selectCapacitorProject(
  candidates: CapacitorProjectCandidate[],
  prompts: BuilderProjectPrompts,
): Promise<CapacitorProjectCandidate | undefined> {
  if (candidates.length === 0)
    return undefined

  if (candidates.length === 1) {
    const answer = await prompts.confirm(candidates[0])
    return answer === true ? candidates[0] : undefined
  }

  const selectedDir = await prompts.select(candidates)
  return typeof selectedDir === 'string'
    ? candidates.find(candidate => candidate.dir === selectedDir)
    : undefined
}

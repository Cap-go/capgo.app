import type { OnboardingScanProject } from './notify-app-ready-project'
import { join } from 'node:path'
import { getUpdaterInstallState } from '../init/updater'

export function scanUpdaterInstalled(project: OnboardingScanProject): 'found' | 'not_found' {
  // A declaration alone, or another app's hoisted dependency, is insufficient.
  return getUpdaterInstallState(join(project.dir, 'package.json')).ready ? 'found' : 'not_found'
}

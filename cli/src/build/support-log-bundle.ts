import type { SupportBundleFiles } from '../onboarding-support.js'
import { readFile } from 'node:fs/promises'
import { readCapturedLog } from '../ai/log-capture.js'
import { writeSupportBundleFiles } from '../onboarding-support.js'

export interface PrepareBuildSupportLogBundleInput {
  appId: string
  jobId: string
  internalLogPath?: string | null
  outputDir?: string
}

export interface PrepareBuildSupportLogBundleDependencies {
  readCapturedLog: (jobId: string) => Promise<string>
  readInternalLog: (path: string) => Promise<string>
}

const defaultDependencies: PrepareBuildSupportLogBundleDependencies = {
  readCapturedLog,
  readInternalLog: path => readFile(path, 'utf8'),
}

/**
 * Drain the ordered Builder-log write queue before rendering a support bundle.
 * The Builder log is required diagnostic input: unlike the optional internal
 * log, a capture/read failure rejects instead of producing a misleading empty
 * `Recent logs` section.
 */
export async function prepareBuildSupportLogBundle(
  input: PrepareBuildSupportLogBundleInput,
  dependencies: PrepareBuildSupportLogBundleDependencies = defaultDependencies,
): Promise<SupportBundleFiles | null> {
  let internalLines: string[] = []
  if (input.internalLogPath) {
    try {
      internalLines = (await dependencies.readInternalLog(input.internalLogPath)).split('\n')
    }
    catch {
      // The CLI's internal log is supplementary; the Builder output below is required.
    }
  }

  const buildLogLines = (await dependencies.readCapturedLog(input.jobId)).split('\n')
  return writeSupportBundleFiles({
    kind: 'build-request',
    appId: input.appId,
    error: `Cloud build ${input.jobId} failed`,
    logs: buildLogLines,
    sections: internalLines.length > 0 ? [{ title: 'Internal log', lines: internalLines }] : [],
  }, input.outputDir)
}

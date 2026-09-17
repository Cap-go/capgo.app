import type { Command } from 'commander'
import { randomUUID } from 'node:crypto'
import { cwd } from 'node:process'
import { Worker } from 'node:worker_threads'
import { registerOnboardingCheck } from './background-workers'

export interface OnboardingCheckOptions {
  cwd: string
  command: string
  attemptId?: string
  appId?: string
  apikey?: string
  capacitorConfig?: string
  packageJson?: string
  mainFile?: string
  supaHost?: string
  supaAnon?: string
}

export function startOnboardingCheck(command: Command, commandPath: string, workerUrl: URL): void {
  try {
    const options = command.optsWithGlobals()
    const argument = (name: string) => {
      const index = command.registeredArguments.findIndex(arg => arg.name() === name)
      return index < 0 ? undefined : command.args[index]
    }
    const text = (value: unknown) => typeof value === 'string' ? value : undefined
    const attemptId = randomUUID()
    const workerData: OnboardingCheckOptions = {
      cwd: cwd(),
      command: commandPath,
      attemptId,
      appId: text(options.appId) ?? argument('appId'),
      apikey: text(options.apikey) ?? argument('apikey'),
      capacitorConfig: text(options.capacitorConfig),
      packageJson: text(options.packageJson),
      mainFile: text(options.mainFile),
      supaHost: text(options.supaHost),
      supaAnon: text(options.supaAnon),
    }
    const worker = new Worker(workerUrl, { workerData, stdout: true, stderr: true })
    // Discovery/config loading must not write into terminal UIs or MCP stdout.
    // Discard captured streams so incoming output cannot reference the worker's IPC port.
    worker.stdout?.destroy()
    worker.stderr?.destroy()
    worker.on('error', () => {})
    registerOnboardingCheck(worker, attemptId)
    // Both detection and reporting can be abandoned when the command exits.
    worker.unref()
  }
  catch {
    // Optional onboarding detection must never affect the requested command.
  }
}

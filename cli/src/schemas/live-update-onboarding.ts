// src/schemas/live-update-onboarding.ts
import { z } from 'zod'
import { capacitorConfigOptionSchema } from './sdk'

const packageJsonSchema = z.string().min(1).describe('Package JSON for the Capacitor app to onboard. Use this with capacitorConfig when a monorepo config source lives outside the app directory.')
const mainFileSchema = z.string().min(1).describe('Application entry file to update. Use this with capacitorConfig when a monorepo app has a separate main file.')

export const liveUpdateStartSchema = z.object({
  capacitorConfig: capacitorConfigOptionSchema.describe('Existing app-specific capacitor.config.* file to update while Capacitor loads the active root config (useful with dynamic monorepos).').optional(),
  packageJson: packageJsonSchema.optional(),
  mainFile: mainFileSchema.optional(),
})

export const liveUpdateNextStepSchema = z.object({
  capacitorConfig: capacitorConfigOptionSchema.describe('The same app-specific capacitor.config.* source used to start onboarding when more than one source is active for this app.').optional(),
  packageJson: packageJsonSchema.optional(),
  mainFile: mainFileSchema.optional(),
  resumeChoice: z.enum(['continue', 'restart']).describe('Answer to the resume prompt: "continue" resumes saved progress, "restart" wipes it').optional(),
  encryptionChoice: z.enum(['enable', 'skip']).describe('Answer at setup-encryption: "enable" turns on bundle encryption, "skip" leaves it off').optional(),
  platform: z.enum(['ios', 'android']).describe('Answer at select-platform: target device platform').optional(),
  dirtyGitAction: z.enum(['check-again', 'continue-dirty']).describe('Answer at dirty-git: re-check after cleaning the repo, or continue with uncommitted changes').optional(),
  testChangeChoice: z.enum(['agent', 'manual']).describe('Answer at test-change-choice: "agent" means you (the AI assistant) make a small temporary visible change following the returned guidelines, "manual" means the user makes it themselves').optional(),
  testChangeReady: z.boolean().describe('Set true once the visible test change is saved (make-test-change-manual or make-test-change-agent step)').optional(),
  testChangeFiles: z.array(z.string().min(1).max(500)).max(10).describe('At make-test-change-agent: project-relative paths of the files you changed for the test, so you can revert them after the update is confirmed').optional(),
  testChangeDescription: z.string().min(1).max(300).describe('At make-test-change-agent: what the user should look for on the device, e.g. "the home title now reads Hello from Capgo"').optional(),
  deviceRunConfirmed: z.boolean().describe('Set true after the user ran the app on a device/simulator (run-on-device step)').optional(),
  otaReceivedConfirmed: z.boolean().describe('Set true after the user confirms the OTA update appeared on device (test-update step)').optional(),
})

export type LiveUpdateStartInput = z.infer<typeof liveUpdateStartSchema>
export type LiveUpdateNextStepInput = z.infer<typeof liveUpdateNextStepSchema>

export const liveUpdateExplainInputSchema = z.object({
  state: z.string().optional().describe('Optional state name to explain (from a prior result state field).'),
  capacitorConfig: capacitorConfigOptionSchema.describe('The same app-specific capacitor.config.* source used to start onboarding when more than one source is active for this app.').optional(),
})

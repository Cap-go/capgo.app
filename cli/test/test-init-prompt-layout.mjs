import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../src/init/ui/app.tsx', import.meta.url))
const source = readFileSync(appPath, 'utf8')

const introIndex = source.indexOf('<ScreenIntro')
const progressIndex = source.indexOf('<ProgressSection')
const currentStepIndex = source.indexOf('<CurrentStepSection')
const promptIndex = source.indexOf('<PromptArea')

assert.ok(introIndex < promptIndex, 'the onboarding intro must render before prompts')
assert.ok(progressIndex < promptIndex, 'onboarding progress must render before prompts')
assert.ok(currentStepIndex < promptIndex, 'the current onboarding step must render before prompts')

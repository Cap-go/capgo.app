import type { OnboardingDevelopmentEnvironment } from '../../utils/onboardingProgressAnalytics'

// Prefer import.meta.url over `?url` imports: unplugin-vue-better-define (visual-diff
// vite build) resolves `file.svg?url` as a literal path and ENOENTs.
const assistantClaude = new URL('../../assets/onboarding-tools/assistant-claude.svg', import.meta.url).href
const assistantCodex = new URL('../../assets/onboarding-tools/assistant-codex.svg', import.meta.url).href
const assistantCopilot = new URL('../../assets/onboarding-tools/assistant-copilot.svg', import.meta.url).href
const assistantCursor = new URL('../../assets/onboarding-tools/assistant-cursor.svg', import.meta.url).href
const assistantOpencode = new URL('../../assets/onboarding-tools/assistant-opencode.svg', import.meta.url).href
const assistantWindsurf = new URL('../../assets/onboarding-tools/assistant-windsurf.svg', import.meta.url).href
const editorJetbrains = new URL('../../assets/onboarding-tools/editor-jetbrains.svg', import.meta.url).href
const editorNeovim = new URL('../../assets/onboarding-tools/editor-neovim.svg', import.meta.url).href
const editorTerminal = new URL('../../assets/onboarding-tools/editor-terminal.svg', import.meta.url).href
const editorVim = new URL('../../assets/onboarding-tools/editor-vim.svg', import.meta.url).href
const editorVscode = new URL('../../assets/onboarding-tools/editor-vscode.svg', import.meta.url).href
const hostedBase44 = new URL('../../assets/onboarding-tools/hosted-base44.png', import.meta.url).href
const hostedBolt = new URL('../../assets/onboarding-tools/hosted-bolt.png', import.meta.url).href
const hostedLovable = new URL('../../assets/onboarding-tools/hosted-lovable.png', import.meta.url).href
const hostedV0 = new URL('../../assets/onboarding-tools/hosted-v0.svg', import.meta.url).href

export interface OnboardingDevelopmentEnvironmentOption {
  value: Exclude<OnboardingDevelopmentEnvironment, 'skipped' | 'local_project' | 'exploring'>
  icons: string[]
  muted: boolean
  hasDescription: boolean
}

export const developmentEnvironmentOptions: OnboardingDevelopmentEnvironmentOption[] = [
  {
    value: 'hosted_builder',
    icons: [hostedBolt, hostedLovable, hostedV0, hostedBase44],
    muted: false,
    hasDescription: true,
  },
  {
    value: 'ai_assistant',
    icons: [assistantClaude, assistantCodex, assistantCursor, assistantOpencode, assistantCopilot, assistantWindsurf],
    muted: true,
    hasDescription: true,
  },
  {
    value: 'hand_coded',
    icons: [editorTerminal, editorVim, editorVscode, editorNeovim, editorJetbrains],
    muted: true,
    hasDescription: true,
  },
  {
    value: 'other',
    icons: [],
    muted: false,
    hasDescription: false,
  },
]

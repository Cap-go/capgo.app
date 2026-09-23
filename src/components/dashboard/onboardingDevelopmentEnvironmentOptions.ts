import type { OnboardingDevelopmentEnvironment } from '../../utils/onboardingProgressAnalytics'
import assistantClaude from '../../assets/onboarding-tools/assistant-claude.svg?url'
import assistantCodex from '../../assets/onboarding-tools/assistant-codex.svg?url'
import assistantCopilot from '../../assets/onboarding-tools/assistant-copilot.svg?url'
import assistantCursor from '../../assets/onboarding-tools/assistant-cursor.svg?url'
import assistantOpencode from '../../assets/onboarding-tools/assistant-opencode.svg?url'
import assistantWindsurf from '../../assets/onboarding-tools/assistant-windsurf.svg?url'
import editorJetbrains from '../../assets/onboarding-tools/editor-jetbrains.svg?url'
import editorNeovim from '../../assets/onboarding-tools/editor-neovim.svg?url'
import editorTerminal from '../../assets/onboarding-tools/editor-terminal.svg?url'
import editorVim from '../../assets/onboarding-tools/editor-vim.svg?url'
import editorVscode from '../../assets/onboarding-tools/editor-vscode.svg?url'
import hostedBase44 from '../../assets/onboarding-tools/hosted-base44.png?url'
import hostedBolt from '../../assets/onboarding-tools/hosted-bolt.png?url'
import hostedLovable from '../../assets/onboarding-tools/hosted-lovable.png?url'
import hostedV0 from '../../assets/onboarding-tools/hosted-v0.svg?url'

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

import type { Evaluation } from './contracts.ts'
import { invitationEvaluation } from './flows/invitations.ts'

// Executable registry: add a named evaluation and its cadence here. Each
// evaluation owns a whole-cohort read-only finder and a helper-only handler.
export const bentoFlows: Record<string, Evaluation> = Object.fromEntries([
  invitationEvaluation('new', 1, { everyMinutes: 1 }),
  invitationEvaluation('new', 2, { everyMinutes: 1 }),
  invitationEvaluation('existing', 1, { everyMinutes: 1 }),
  invitationEvaluation('existing', 2, { everyMinutes: 1 }),
].map(evaluation => [evaluation.key, evaluation]))

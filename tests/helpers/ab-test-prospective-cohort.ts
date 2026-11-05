// The retired `new_emails_v2` production experiment. Kept as a fixture so the
// generic enrollment, deterministic allocation and dependency features stay covered.
export const PROSPECTIVE_COHORT_FIXTURE = {
  new_emails_v2: {
    audience: 'self_signup',
    intents: ['ota', 'builder'],
    label: 'Adaptive lifecycle emails',
    treatment_percentage: 0,
    treatment_percentage_by_intent: { ota: 50, builder: 100 },
    required_assignments_by_intent: { builder: { builder_todo_list_v4: 'A' } },
    allocation: 'deterministic',
    assign_control: false,
    enroll_new_users_after: '2026-10-17T14:24:00.000Z',
    treatment_branch: 'A',
    control_branch: 'B',
    branches: {
      A: { bento_tag: 'ab:new_emails_v2', label: 'Adaptive lifecycle emails' },
      B: { bento_tag: 'ab:no_new_emails_v2', label: 'No adaptive lifecycle emails' },
    },
  },
}

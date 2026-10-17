import type { Candidate, LifecycleInput } from './types.ts'
import contract from '../../../../docs/bento/lifecycle-v2-contract.json' with { type: 'json' }
import { isLifecycleCommercialOffer } from './commercial.ts'
import { nextTask } from './evidence.ts'

export function lifecycleBranch(product: string, key: string) {
  const branch = contract.branches.find(item => item.product === product && item.key === key)
  if (!branch)
    throw new Error('Unknown lifecycle sender branch')
  return branch
}

export function buildLifecycleEvent(input: LifecycleInput, candidate: Candidate, dispatchId: string, webappUrl: string) {
  const base = new URL(webappUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('Invalid lifecycle webapp URL')
  const url = (path: string) => new URL(path, base).href
  const app = input.evidence
  const task = app?.healthy && input.sourceHealthy ? nextTask(app) : null
  const plan = input.plan
  const purchase = isLifecycleCommercialOffer(input, candidate.branch) || candidate.branch.includes('ready')
  const plansUrl = url(`/settings/organization/plans?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`)
  const fundingUrl = url(`/settings/organization/credits?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`)
  const funding = candidate.branch === 'funding_blocked'
  const setupUrl = app ? url(`/app/${encodeURIComponent(app.appId)}/getting-started?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`) : url(`${input.product === 'ota' ? '/app/new' : '/apps'}?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`)
  const nextReleaseUrl = app ? url(`/app/${encodeURIComponent(app.appId)}/${input.product === 'ota' ? 'bundles' : 'builds'}?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`) : setupUrl
  const currentFacts = input.sourceHealthy ? app?.facts.filter(fact => fact.kind === 'task') ?? [] : []
  const batchFacts = input.state.batch?.incarnation === app?.incarnation ? input.state.batch?.facts ?? [] : []
  const lines = (facts: typeof currentFacts) => facts.map(fact => `✅ ${fact.acknowledgement}`).join('\n')
  const summary = lines(currentFacts)
  const title = task?.title ?? (app ? 'Keep your next release moving' : 'Choose the app you want to set up')
  const explanation = task?.explanation ?? (app ? 'Open your current app to choose the next useful step. Reply if you would like a hand.' : 'Create or choose your current app in Capgo. Your previous progress stays with its original app.')
  const deadlineText = input.trialDeadline ? new Date(input.trialDeadline).toISOString().slice(0, 10) : ''
  const trialIntro = deadlineText ? `Your organization’s trial deadline is ${deadlineText} (UTC). ${input.state.checklistCompleteAt ? 'Your team has completed the product checklist.' : (task ? 'Here is the useful next step for your current setup.' : 'Reply if you would like help choosing how to continue.')}` : ''
  let subject = app ? `✨ ${app.name || 'Your app'}: ${title}` : '🧩 Let’s get your next app ready'
  if (candidate.branch.startsWith('today_'))
    subject = '🚨 Capgo payment incoming !'
  else if (candidate.purpose.startsWith('trial:'))
    subject = `🕒 Your Capgo trial: ${deadlineText}`
  else if (candidate.branch.includes('success'))
    subject = input.product === 'ota' ? '✨ Your first update is running' : '☁️ Your first cloud build succeeded'
  const data: Record<string, unknown> = Object.fromEntries(contract.required_string_fields.map(key => [key, '']))
  Object.assign(data, {
    dispatch_id: dispatchId,
    unique: { key: dispatchId },
    org_id: input.orgId,
    org_name: input.orgName,
    app_id: app?.appId ?? '',
    app_incarnation: app?.incarnation ?? '',
    app_name: app ? app.name.trim() || app.appId || 'your app' : '',
    product: input.product,
    platform_label: app?.platform === 'ios' ? 'iOS' : app?.platform === 'android' ? 'Android' : '',
    completed_steps_summary: summary,
    progress_summary: batchFacts.length ? lines(batchFacts) : summary,
    next_action_title: title,
    next_action_explanation: explanation,
    continue_url: funding ? fundingUrl : purchase ? plansUrl : app && !task ? nextReleaseUrl : setupUrl,
    cta_label: funding ? 'Review build allowance' : purchase ? `Choose ${plan?.name ?? 'a plan'}` : task?.ctaLabel ?? (app ? input.product === 'ota' ? 'Open my bundles' : 'Open my builds' : 'Choose my app'),
    ai_setup_url: setupUrl,
    org_preferences_url: url(`/settings/organization/notifications?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`),
    pause_url: url(`/settings/organization/notifications?oid=${encodeURIComponent(input.orgId)}&source=capgo_lifecycle`),
    plan_url: plansUrl,
    recommended_plan_name: plan?.name ?? '',
    recommended_plan_price: plan ? `$${plan.monthlyPrice}/month` : '',
    recommended_monthly_price_label: plan ? `$${plan.monthlyPrice}/month` : '',
    recommendation_reason: plan?.reason ?? '',
    plan_fit_reason: plan?.reason ?? '',
    recommended_plan_includes: plan?.includes ?? '',
    plan_allowance_summary: plan?.includes ?? '',
    plan_cta_label: plan ? `Choose ${plan.name}` : 'Compare plans',
    trial_setup_intro: trialIntro,
    trial_deadline: input.trialDeadline ?? '',
    funding_explanation: app?.fundingBlocked ? 'The current build allowance needs attention before the next build.' : '',
    funding_action_explanation: app?.fundingBlocked ? 'Open your organization’s billing settings to review the available build allowance.' : '',
    funding_recommendation: app?.fundingBlocked ? 'Review the current allowance or reply for help choosing the next step.' : '',
    funding_cta_label: app?.fundingBlocked ? 'Review build allowance' : '',
    email_subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 250),
    email_snippet: 'You’re close to the next useful step. We’re here if you need help 💚',
    checklist_complete: input.state.checklistCompleteAt !== null,
    first_value_verified: input.state.firstValueAt !== null,
  })
  return { email: input.email, event: lifecycleBranch(input.product, candidate.branch).event, data }
}

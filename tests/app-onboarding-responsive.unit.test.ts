import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const flowSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const pageSource = readFileSync(new URL('../src/pages/onboarding/app.vue', import.meta.url), 'utf8')

describe('app-creation onboarding responsive layout', () => {
  it.concurrent('scopes compact layout rules to the pre-organization app-creation steps', () => {
    expect(flowSource).toContain("'onboarding-flow-app-creation': props.preOrg && (flowStep === 'intent' || flowStep === 'details')")
    expect(flowSource).toContain("'onboarding-flow-intent': props.preOrg && flowStep === 'intent'")
    expect(flowSource).toContain("'onboarding-flow-details-name': flowStep === 'details' && appDetailsStep === 'name'")
    expect(flowSource).toContain("'onboarding-flow-details-app-id': flowStep === 'details' && appDetailsStep === 'app_id'")
    expect(flowSource).toContain("'onboarding-flow-details-icon': flowStep === 'details' && appDetailsStep === 'icon'")
    expect(pageSource).toContain(':deep(.onboarding-flow-app-creation)')
    expect(pageSource).not.toContain(':deep(.onboarding-flow-shell)')
    expect(pageSource).not.toMatch(/:deep\(\.onboarding-flow-details-(?:name|app-id|icon)/)
    expect(pageSource).not.toContain(':deep(.onboarding-flow-intent')
    expect(pageSource).toContain(':deep(.onboarding-flow-app-creation.onboarding-flow-details-app-id')
    expect(pageSource).toContain(':deep(.onboarding-flow-app-creation.onboarding-flow-details-icon')
  })

  it.concurrent('drops secondary content progressively before primary actions on short screens', () => {
    const genericCompactLayout = pageSource.slice(
      pageSource.indexOf('@media (min-width: 640px) and (max-height: 800px)'),
      pageSource.indexOf('@media (min-width: 640px) and (max-height: 700px)'),
    )
    const nameCompactLayout = pageSource.slice(
      pageSource.indexOf('@media (min-width: 640px) and (max-height: 700px)'),
      pageSource.indexOf('@media (min-width: 640px) and (max-height: 640px)'),
    )

    expect(genericCompactLayout).toContain('.onboarding-flow-app-creation:not(.onboarding-flow-details-name)')
    expect(genericCompactLayout).not.toContain(':deep(.onboarding-flow-app-creation) {')
    expect(genericCompactLayout).not.toContain(':deep(.onboarding-flow-app-creation .onboarding-flow-badge)')
    expect(nameCompactLayout).toContain('.onboarding-flow-details-name .onboarding-flow-badge')
    expect(pageSource).toContain('@media (min-width: 640px) and (max-height: 600px)')
    expect(pageSource).toContain('.onboarding-flow-details-app-id .onboarding-details-preview-app-id')
    expect(pageSource).toContain('@media (min-width: 640px) and (max-height: 590px)')
    expect(pageSource).toContain('.onboarding-flow-details-icon .onboarding-icon-identity')
    expect(pageSource).toContain('@media (min-width: 640px) and (max-height: 550px)')
    expect(pageSource).toContain('.onboarding-flow-details-name .onboarding-details-eyebrow')
    expect(pageSource).toContain('@media (min-width: 640px) and (max-height: 530px)')
    expect(pageSource).toContain('.onboarding-flow-details-name .onboarding-details-preview')
    expect(pageSource).toContain('.onboarding-flow-details-icon .onboarding-flow-title')
    expect(pageSource).toContain('@media (min-width: 640px) and (max-height: 500px)')
    expect(pageSource).toContain('.onboarding-flow-details-app-id .onboarding-flow-title')
  })

  it.concurrent('uses a dedicated compact mobile presentation', () => {
    expect(pageSource).toContain('@media (max-width: 639px)')
    expect(pageSource).toContain('.onboarding-flow-intent .onboarding-intent-option-description')
    expect(pageSource).toContain('.onboarding-flow-details-app-id .onboarding-details-preview-app-id')
    expect(pageSource).toContain('@media (max-width: 639px) and (max-height: 700px)')
    expect(pageSource).toContain(':global(body:has(.onboarding-flow-app-creation) .onboarding-page-actions)')
    expect(pageSource).toContain('@media (max-width: 639px) and (max-height: 630px)')
    expect(pageSource).toContain('.onboarding-flow-details-name .onboarding-flow-title')
  })
})

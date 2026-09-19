import { describe, expect, it } from 'vitest'
import { getLogDocAnchor, getLogDocUrl } from '~/services/logDocLinks'

describe('log doc links', () => {
  it.concurrent('lowercases camelCase action codes for doc fragments', () => {
    expect(getLogDocAnchor('needPlanUpgrade')).toBe('needplanupgrade')
    expect(getLogDocUrl('needPlanUpgrade')).toBe(
      'https://capgo.app/docs/plugins/updater/debugging/#needplanupgrade',
    )
  })

  it.concurrent('keeps snake_case action codes for doc fragments', () => {
    expect(getLogDocAnchor('backend_refusal')).toBe('backend_refusal')
    expect(getLogDocUrl('webview_javascript_error')).toBe(
      'https://capgo.app/docs/plugins/updater/debugging/#webview_javascript_error',
    )
  })
})

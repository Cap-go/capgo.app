import { readFileSync } from 'node:fs'
import { Liquid } from 'liquidjs'
import { describe, expect, it } from 'vitest'

const base = new URL('../supabase/templates/bento/', import.meta.url)
const templates = JSON.parse(readFileSync(new URL('lifecycle-copy.json', base), 'utf8')) as { id: number, file: string, subject: string }[]
const engine = new Liquid()

async function render(id: number, tags: string[] = [], details: Record<string, unknown> = {}) {
  const template = templates.find(template => template.id === id)!
  const context = {
    visitor: { tags, first_name: '<img src=x>', unsubscribe_url: 'https://example.com/unsubscribe' },
    event: { details },
  }
  return {
    html: await engine.parseAndRender(readFileSync(new URL(template.file, base), 'utf8'), context),
    subject: await engine.parseAndRender(template.subject, context),
  }
}

describe('Bento lifecycle copy', () => {
  it.concurrent.each(templates)('renders template $id for both intents without raw Liquid or unescaped names', async ({ id }) => {
    for (const tags of [[], ['onboarding_intent:builder']]) {
      const { html, subject } = await render(id, tags)
      expect(html).not.toContain('{{')
      expect(html).not.toContain('{%')
      expect(html).not.toContain('<img')
      expect(html).toContain('&lt;img')
      expect(html).toContain('https://example.com/unsubscribe')
      expect(subject).not.toContain('{%')
      expect(subject.trim()).not.toBe('')
    }
  })

  it.concurrent('offers setup help to direct-offer users without promising a trial or account closure', async () => {
    const { html, subject } = await render(43121, ['offer=direct', 'onboarding_intent:builder'])
    expect(html).toContain('first native build')
    expect(html + subject).not.toMatch(/trial|close.*account|15-min|book/i)
  })

  it.concurrent('uses the matching product intent and one plan destination', async () => {
    const builder = await render(110589, ['onboarding_intent:builder'])
    const updater = await render(110589)
    expect(builder.html).toContain('iOS or Android')
    expect(builder.subject).toContain('native build')
    expect(updater.html).toContain('test channel')
    expect(updater.subject).toContain('live update')
    for (const { html } of [builder, updater]) {
      expect(html.match(/href="https:\/\/console.capgo.app\/settings\/organization\/plans\/"/g)).toHaveLength(1)
      expect(html).not.toContain('<button')
      expect(html).not.toMatch(/trial ended|paused|one minute/i)
    }
  })

  it.concurrent('escapes bundle names and encodes the destination', async () => {
    const { html } = await render(85770, [], { app_id: 'com.example.app', bundle_id: '123', bundle_name: '<script>test</script>' })
    expect(html).toContain('/app/com.example.app/bundle/123')
    expect(html).toContain('&lt;script&gt;test&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    const encoded = await render(85770, [], { app_id: 'example/app', bundle_id: 'id?x="test"' })
    expect(encoded.html).toContain('/app/example%2Fapp/bundle/id%3Fx%3D%22test%22')
  })

  it.concurrent.each([{}, { app_id: 'com.example.app' }, { bundle_id: '123' }, { app_id: '', bundle_id: '123' }])('uses the app list when the bundle destination is incomplete: %j', async (details) => {
    const { html } = await render(85770, [], details)
    expect(html).toContain('href="https://console.capgo.app/apps"')
    expect(html).not.toContain('/app/')
  })
})

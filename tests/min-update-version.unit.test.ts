// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import InfoRow from '../src/components/package/InfoRow.vue'
import { resolveMinUpdateVersionCommit } from '../src/services/minUpdateVersion'

describe('resolveMinUpdateVersionCommit', () => {
  it.each([
    ['1.2.3', '1.2.3', { kind: 'noop' }],
    [' 1.2.3 ', '1.2.3', { kind: 'noop' }],
    ['', null, { kind: 'noop' }],
    ['', '1.2.3', { kind: 'empty' }],
    ['   ', '1.2.3', { kind: 'empty' }],
    [undefined, '1.2.3', { kind: 'empty' }],
    ['not-a-version', '1.2.3', { kind: 'invalid' }],
    ['1.2', '1.2.3', { kind: 'invalid' }],
    ['1.3.0', '1.2.3', { kind: 'save', value: '1.3.0' }],
    [' 2.0.0 ', null, { kind: 'save', value: '2.0.0' }],
  ] as const)('input %j with stored %j resolves to %j', (input, stored, expected) => {
    expect(resolveMinUpdateVersionCommit(input, stored)).toEqual(expected)
  })
})

describe('min update version field', () => {
  const mounted: Array<() => void> = []

  afterEach(() => {
    mounted.splice(0).forEach(unmount => unmount())
  })

  async function mountField(stored: string | null) {
    const storedValue = ref(stored)
    const writes: Array<string | null> = []
    const row = ref<{ reset: () => void } | null>(null)
    // Mirrors saveCustomId in [app].bundle.[bundle].vue: only `save` writes.
    const onUpdate = vi.fn((input: string | undefined) => {
      const commit = resolveMinUpdateVersionCommit(input, storedValue.value)
      if (commit.kind !== 'save') {
        row.value?.reset()
        return
      }
      writes.push(commit.value)
      storedValue.value = commit.value
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render: () => h(InfoRow, {
        'ref': row,
        'label': 'Minimal update version',
        'editable': true,
        'value': storedValue.value ?? '',
        'placeholder': 'e.g. 1.0.0',
        'onUpdate:value': onUpdate,
      }),
    })
    app.mount(container)
    mounted.push(() => {
      app.unmount()
      container.remove()
    })
    await nextTick()
    const input = container.querySelector('input') as HTMLInputElement
    return { input, onUpdate, writes }
  }

  async function typeAndBlur(input: HTMLInputElement, value: string) {
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new Event('blur'))
    await nextTick()
  }

  it('shows the stored value in a real input with a placeholder', async () => {
    const { input } = await mountField('1.2.3')
    expect(input.value).toBe('1.2.3')
    expect(input.type).toBe('text')
    expect(input.placeholder).toBe('e.g. 1.0.0')
    expect(input.classList.contains('border')).toBe(true)
    expect(input.classList.contains('focus:ring-2')).toBe(true)
  })

  it('does not emit or write when focused then blurred without a change', async () => {
    const { input, onUpdate, writes } = await mountField('1.2.3')
    input.focus()
    input.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(input.value).toBe('1.2.3')
  })

  it('never writes null when the field is cleared then blurred, and reverts', async () => {
    const { input, onUpdate, writes } = await mountField('1.2.3')
    await typeAndBlur(input, '')
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
    expect(input.value).toBe('1.2.3')
  })

  it('does not write while typing, only once on blur', async () => {
    const { input, onUpdate, writes } = await mountField('1.2.3')
    input.focus()
    for (const value of ['1', '1.', '1.3', '1.3.', '1.3.0']) {
      input.value = value
      input.dispatchEvent(new Event('input'))
      await nextTick()
    }
    expect(onUpdate).not.toHaveBeenCalled()
    input.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(writes).toEqual(['1.3.0'])
    expect(input.value).toBe('1.3.0')
  })

  it('keeps a newer draft typed while an earlier save is still pending', async () => {
    const storedValue = ref<string>('1.2.3')
    const writes: string[] = []
    let finishSave: (() => void) | undefined
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render: () => h(InfoRow, {
        'label': 'Minimal update version',
        'editable': true,
        'value': storedValue.value,
        'onUpdate:value': (value: string) => {
          writes.push(value)
          finishSave = () => {
            storedValue.value = value
          }
        },
      }),
    })
    app.mount(container)
    mounted.push(() => {
      app.unmount()
      container.remove()
    })
    await nextTick()
    const input = container.querySelector('input') as HTMLInputElement

    await typeAndBlur(input, '1.3.0')
    expect(writes).toEqual(['1.3.0'])
    input.focus()
    input.value = '1.4.0'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    finishSave?.()
    await nextTick()
    expect(storedValue.value).toBe('1.3.0')
    expect(input.value).toBe('1.4.0')

    input.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(writes).toEqual(['1.3.0', '1.4.0'])
  })

  it('commits on Enter but not on an Enter that confirms an IME composition', async () => {
    const { input, onUpdate, writes } = await mountField('1.2.3')
    input.focus()
    input.value = '1.3.0'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    await nextTick()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(writes).toEqual(['1.3.0'])
  })

  it('does not commit while the field is read only (save in flight or no permission)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const onUpdate = vi.fn()
    const app = createApp({
      render: () => h(InfoRow, {
        'label': 'Minimal update version',
        'editable': true,
        'readonly': true,
        'value': '1.2.3',
        'onUpdate:value': onUpdate,
      }),
    })
    app.mount(container)
    mounted.push(() => {
      app.unmount()
      container.remove()
    })
    await nextTick()
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    await typeAndBlur(input, '')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('reverts an invalid semver without writing', async () => {
    const { input, writes } = await mountField('1.2.3')
    await typeAndBlur(input, 'abc')
    expect(writes).toEqual([])
    expect(input.value).toBe('1.2.3')
  })
})

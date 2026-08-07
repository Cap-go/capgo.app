export type AiBinding = {
  run: (model: string, input: unknown) => Promise<unknown>
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function extractContentText(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''

  return content.map((item) => {
    if (typeof item === 'string')
      return item
    const itemRecord = recordOf(item)
    return typeof itemRecord?.text === 'string' ? itemRecord.text : ''
  }).join('')
}

export function extractAiText(result: unknown): string {
  if (typeof result === 'string')
    return result

  const resultRecord = recordOf(result)
  if (!resultRecord)
    return ''

  for (const key of ['response', 'text', 'result', 'output']) {
    const value = resultRecord[key]
    if (typeof value === 'string')
      return value
    const valueRecord = recordOf(value)
    if (valueRecord)
      return extractAiText(valueRecord)
    if (Array.isArray(value))
      return extractContentText(value)
  }

  const choices = resultRecord.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const choiceRecord = recordOf(choice)
      if (typeof choiceRecord?.text === 'string')
        return choiceRecord.text
      const message = recordOf(choiceRecord?.message)
      const text = extractContentText(message?.content)
      if (text)
        return text
    }
  }

  return ''
}

export function parseJsonObjectFromAiText(value: unknown): Record<string, unknown> | null {
  const record = recordOf(value)
  if (record)
    return record

  if (typeof value !== 'string')
    return null

  const trimmed = value.trim()
  if (!trimmed)
    return null

  try {
    return recordOf(JSON.parse(trimmed))
  }
  catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start)
      return null
    try {
      return recordOf(JSON.parse(trimmed.slice(start, end + 1)))
    }
    catch {
      return null
    }
  }
}

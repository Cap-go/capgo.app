import { describe, expect, it } from 'vitest'
import { disableThinkingOptions } from '../supabase/functions/_backend/utils/workers_ai.ts'

describe('disableThinkingOptions', () => {
  it.concurrent('turns thinking off for hybrid reasoning model families', () => {
    for (const model of ['@cf/qwen/qwen3.8-27b', '@cf/deepseek-ai/deepseek-v4.1-flash-1017', '@cf/zai-org/glm-5.3', '@cf/google/gemma-4-26b-a4b-it'])
      expect(disableThinkingOptions(model)).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })

  it.concurrent('sends nothing extra for other models', () => {
    expect(disableThinkingOptions('@cf/custom/non-reasoning-model')).toEqual({})
  })
})

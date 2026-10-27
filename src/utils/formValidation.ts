import { i18n } from '~/modules/i18n'

/**
 * Small field validators that replace FormKit's validation rules.
 * Each rule returns an error message, or null when the value passes.
 */
export type FieldRule = (value: unknown) => string | null

function t(key: string, params: Record<string, unknown>) {
  return i18n.global.t(key, params)
}

function text(value: unknown) {
  if (typeof value === 'string')
    return value
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*(?:\.[^\s.@]+)+$/
// Same set as FormKit's contains_symbol rule: ASCII punctuation.
const ASCII_SYMBOL_PATTERN = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const rules = {
  /** Fails on empty values; `trim` also rejects whitespace-only text. */
  required: (label: string, { trim = false } = {}): FieldRule => (value) => {
    const content = trim ? text(value).trim() : text(value)
    return content.length > 0 ? null : t('validation-required', { label })
  },
  email: (): FieldRule => value => (!text(value) || EMAIL_PATTERN.test(text(value).trim()) ? null : t('validation-email', {})),
  /** Character count between `min` and `max` (inclusive). Empty values pass; combine with `required`. */
  length: (label: string, min: number, max = Number.POSITIVE_INFINITY): FieldRule => (value) => {
    const length = text(value).length
    if (length === 0 || (length >= min && length <= max))
      return null
    if (max === Number.POSITIVE_INFINITY)
      return t('validation-length-min', { label, min })
    if (min <= 0)
      return t('validation-length-max', { label, max })
    return t('validation-length-between', { label, min, max })
  },
  /** Numeric lower bound. Empty values pass; combine with `required`. */
  min: (label: string, min: number): FieldRule => (value) => {
    if (text(value) === '')
      return null
    const number = Number(value)
    return Number.isFinite(number) && number >= min ? null : t('validation-min', { label, min })
  },
  uuid: (label: string): FieldRule => value => (!text(value) || UUID_PATTERN.test(text(value).trim()) ? null : t('validation-uuid', { label })),
  /** Must equal another field, e.g. a password confirmation. */
  confirm: (label: string, other: () => unknown): FieldRule => value => (text(value) === text(other()) ? null : t('validation-confirm', { label })),
  matches: (pattern: RegExp, message: string): FieldRule => value => (!text(value) || pattern.test(text(value)) ? null : message),
  containsAlpha: (label: string): FieldRule => value => (!text(value) || /\p{L}/u.test(text(value)) ? null : t('validation-contains-alpha', { label })),
  containsUppercase: (label: string): FieldRule => value => (!text(value) || /\p{Lu}/u.test(text(value)) ? null : t('validation-contains-uppercase', { label })),
  containsLowercase: (label: string): FieldRule => value => (!text(value) || /\p{Ll}/u.test(text(value)) ? null : t('validation-contains-lowercase', { label })),
  containsNumeric: (label: string): FieldRule => value => (!text(value) || /\d/.test(text(value)) ? null : t('validation-contains-numeric', { label })),
  containsSymbol: (label: string): FieldRule => value => (!text(value) || ASCII_SYMBOL_PATTERN.test(text(value)) ? null : t('validation-contains-symbol', { label })),
}

/** Runs every rule and returns all failure messages, in order. */
export function validateField(value: unknown, fieldRules: FieldRule[]): string[] {
  const errors: string[] = []
  for (const rule of fieldRules) {
    const error = rule(value)
    if (error)
      errors.push(error)
  }
  return errors
}

#!/usr/bin/env bun
// Converts Title Case UI labels in messages/en.json to sentence case
// ("Delete Account" -> "Delete account"). Full sentences are left alone.
// Usage: bun scripts/i18n_sentence_case.mjs          (dry run, prints changes)
//        bun scripts/i18n_sentence_case.mjs --write  (rewrites messages/en.json)
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../messages/en.json', import.meta.url)

// Capitalized words that are proper nouns: brands, products, plan names, dates, languages.
// All-caps (API, SSO, 2FA) and mixed-case (iOS, GitHub, WebView) words are always kept.
const KEEP_WORDS = new Set([
  'Capgo', 'Capacitor', 'Android', 'Apple', 'Google', 'Discord', 'Slack', 'Stripe', 'Expo', 'Supabase',
  'Cloudflare', 'Ionic', 'Xcode', 'Fastlane', 'Cursor', 'Claude', 'Copilot', 'Windsurf', 'Neovim',
  'Lovable', 'Bolt', 'Replit', 'Builder', 'Enterprise', 'Maker', 'Estonia',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Japanese', 'Chinese', 'Korean',
])
// Multi-word names kept verbatim. Longer phrases first: the regex takes the first match.
const KEEP_PHRASES = [
  'Google Play Store', 'App Store Connect', 'App Store', 'Play Store', 'Google Play', 'App ID', 'Live Updates', 'Standard Webhooks',
  'Capgo Builder', 'Capgo Assistant', 'Capgo Cloud', 'Capgo Updater',
]
// Values that are lists of names or intentionally capitalized.
const SKIP_KEYS = new Set([
  'organization-onboarding-development-environment-option-ai_assistant-desc',
  'organization-onboarding-development-environment-option-hand_coded-desc',
  'organization-onboarding-development-environment-option-hosted_builder-desc',
  'billing-region-option-ee-desc',
  'updater-failures-note-native-link',
  'webhook-test-success',
  'notification-provider-secret-ref-placeholder',
])

const MASK = new RegExp(`${KEEP_PHRASES.join('|')}|\\{[^}]*\\}|\`[^\`]*\`|<[^>]*>`, 'g')

function isLabel(value) {
  // Placeholders, code and HTML don't count as words. Not a sanitizer: output is only inspected.
  const words = value.split(/\{[^}]*\}|`[^`]*`|<[^>]*>/).join(' ').match(/[A-Z][\w'.-]*/gi) ?? []
  const rest = words.slice(1)
  const caps = rest.filter(w => /^[A-Z]/.test(w))
  // Sentences ("Click Save. Then Restart") are not labels.
  return words.length >= 2 && words.length <= 10 && !/[.!?]\s/.test(value) && caps.length > 0 && caps.length >= rest.length / 2
}

export function sentenceCase(value) {
  const masked = []
  const out = value
    .replace(MASK, (m) => {
      masked.push(m)
      return `\0${masked.length - 1}\0`
    })
    .replace(/[\p{L}\d']+/gu, (word, offset, str) => {
      if (!/^\p{Lu}[\p{Ll}']+$/u.test(word) || KEEP_WORDS.has(word.replace(/'s$/, '')))
        return word
      const before = str.slice(0, offset)
      // First word of the string or of a segment ("Warning: Bundles", "Bundle → Channel") stays capitalized.
      if (!/[\p{L}\d\0]/u.test(before) || /[.!?:·→\n]\s*$/.test(before))
        return word
      return word.toLowerCase()
    })
  return out.replace(/\0(\d+)\0/g, (_, i) => masked[Number(i)])
}

if (import.meta.main) {
  const messages = JSON.parse(readFileSync(FILE, 'utf8'))
  let changed = 0
  for (const [key, value] of Object.entries(messages)) {
    if (key.startsWith('$') || SKIP_KEYS.has(key) || !isLabel(value))
      continue
    const next = sentenceCase(value)
    if (next !== value) {
      changed++
      console.log(`${key}: ${JSON.stringify(value)} -> ${JSON.stringify(next)}`)
      messages[key] = next
    }
  }
  console.log(`${changed} values changed`)
  if (process.argv.includes('--write'))
    writeFileSync(FILE, `${JSON.stringify(messages, null, 2)}\n`)
}

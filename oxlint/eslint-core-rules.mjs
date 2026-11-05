// Exposes ESLint core rules that oxlint does not implement natively, so the
// frontend oxlint config can keep enforcing them through `jsPlugins`.
import { builtinRules } from 'eslint/use-at-your-own-risk'

const names = [
  'dot-notation',
  'no-restricted-syntax',
  'no-undef-init',
  'no-unreachable-loop',
  'one-var',
]

export default {
  meta: { name: 'eslint-core' },
  rules: Object.fromEntries(names.map(name => [name, builtinRules.get(name)])),
}

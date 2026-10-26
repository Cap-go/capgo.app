import { env } from 'node:process'

if (typeof Object.groupBy !== 'function') {
  Object.groupBy = function groupBy(items, callbackfn) {
    return Array.from(items).reduce((groups, item, index) => {
      const key = callbackfn(item, index)
      if (!Object.hasOwn(groups, key)) {
        groups[key] = []
      }
      groups[key].push(item)
      return groups
    }, Object.create(null))
  }
}

const { default: antfu } = await import('@antfu/eslint-config')

const config = antfu(
  {
    vue: true,
    formatters: true,
    rules: {
      // These micro-optimisation rules create broad churn across the legacy UI codebase.
      // Keep lint focused on signal over noise for now.
      'e18e/prefer-array-some': 'off',
      'e18e/prefer-date-now': 'off',
      'e18e/prefer-nullish-coalescing': 'off',
      'e18e/prefer-object-has-own': 'off',
      'e18e/prefer-static-regex': 'off',
      'e18e/prefer-timer-args': 'off',
      'no-console': env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': env.NODE_ENV === 'production' ? 'warn' : 'off',
    },
    ignores: [
      'dist',
      'scripts',
      'public',
      'supabase/functions/_script',
      '**/supabase.types*',
      '**/database.types*',
      'supabase/functions/_backend/scripts/*',
      'CHANGELOG.md',
      'src/services/posthog.ts',
    ],
  },
  {
    // Vue-specific overrides
    files: ['**/*.vue'],
    rules: {
      // Globally disallow v-html
      'vue/no-v-html': 'error',
    },
  },
)

// Everything else is linted by oxlint (`.oxlintrc.frontend.json`, including
// oxlint-plugin-vize for templates). ESLint only runs on `.vue` files for the
// rules oxlint cannot cover yet, keeping antfu's exact options and processors.
const ESLINT_ONLY_RULES = new Set([
  // Template parsing and inline `<!-- eslint-disable -->` directives
  'vue/comment-directive',
  'vue/no-parsing-error',
  'vue/jsx-uses-vars',

  // Unused bindings: vue-eslint-parser sees template usage, oxlint JS plugins only see `<script>`
  'unused-imports/no-unused-imports',
  'unused-imports/no-unused-vars',

  // `<style>` block formatting (antfu `formatters`)
  'format/prettier',

  // Covered by oxlint-plugin-vize, but only ESLint can autofix them
  'vue/attribute-hyphenation',
  'vue/attributes-order',
  'vue/block-order',
  'vue/component-name-in-template-casing',
  'vue/component-options-name-casing',
  'vue/define-macros-order',
  'vue/html-quotes',
  'vue/mustache-interpolation-spacing',
  'vue/no-deprecated-dollar-scopedslots-api',
  'vue/no-deprecated-scope-attribute',
  'vue/no-deprecated-slot-attribute',
  'vue/no-deprecated-slot-scope-attribute',
  'vue/no-deprecated-v-bind-sync',
  'vue/no-deprecated-v-on-number-modifiers',
  'vue/no-multi-spaces',
  'vue/no-ref-as-operand',
  'vue/no-useless-v-bind',
  'vue/this-in-template',
  'vue/v-bind-style',
  'vue/v-on-event-hyphenation',
  'vue/v-on-style',
  'vue/v-slot-style',
  // Template rules with no oxlint / oxlint-plugin-vize equivalent (or where vize diverges)
  'vue/array-bracket-spacing',
  'vue/arrow-spacing',
  'vue/block-spacing',
  'vue/block-tag-newline',
  'vue/brace-style',
  'vue/comma-dangle',
  'vue/comma-spacing',
  'vue/comma-style',
  'vue/dot-location',
  'vue/dot-notation',
  'vue/eqeqeq',
  'vue/first-attribute-linebreak',
  'vue/html-closing-bracket-newline',
  'vue/html-closing-bracket-spacing',
  'vue/html-comment-content-spacing',
  'vue/html-end-tags',
  'vue/html-indent',
  'vue/html-self-closing',
  'vue/key-spacing',
  'vue/keyword-spacing',
  'vue/multiline-html-element-content-newline',
  'vue/no-empty-pattern',
  'vue/no-irregular-whitespace',
  'vue/no-loss-of-precision',
  'vue/no-restricted-syntax',
  'vue/no-restricted-v-bind',
  'vue/no-spaces-around-equal-signs-in-attribute',
  'vue/no-sparse-arrays',
  'vue/no-unused-refs',
  'vue/object-curly-spacing',
  'vue/object-property-newline',
  'vue/object-shorthand',
  'vue/one-component-per-file',
  'vue/operator-linebreak',
  'vue/order-in-components',
  'vue/padding-line-between-blocks',
  'vue/prefer-separate-static-class',
  'vue/prefer-template',
  'vue/quote-props',
  'vue/singleline-html-element-content-newline',
  'vue/space-in-parens',
  'vue/space-infix-ops',
  'vue/space-unary-ops',
  'vue/template-curly-spacing',
])

const configs = await config
const disabled = {}
for (const item of configs) {
  for (const rule of Object.keys(item.rules ?? {})) {
    if (!ESLINT_ONLY_RULES.has(rule))
      disabled[rule] = 'off'
  }
}

export default [
  ...configs,
  {
    name: 'capgo/oxlint-covers-the-rest',
    // Directives for rules that moved to oxlint look unused to ESLint.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: disabled,
  },
]

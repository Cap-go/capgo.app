import type { IncomingMessage, ServerResponse } from 'node:http'
// import veauryVitePlugins from 'veaury/vite/index'
import type { Plugin } from 'vite'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import VueI18n from '@intlify/unplugin-vue-i18n/vite'
import tailwindcss from '@tailwindcss/vite'
import Vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import formkit from 'unplugin-formkit/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import VueMacros from 'unplugin-vue-macros/vite'
import { defineConfig } from 'vite'
import devtoolsJson from 'vite-plugin-devtools-json'
import EnvironmentPlugin from 'vite-plugin-environment'
import VueDevTools from 'vite-plugin-vue-devtools'
import Layouts from 'vite-plugin-vue-layouts'
import { VueRouterAutoImports } from 'vue-router/unplugin'
import VueRouter from 'vue-router/vite'
import pack from './package.json'
import { branch, getRightKey } from './scripts/utils.mjs'
import 'vitest/config'

type FrontendConfigKey = 'api_domain' | 'base_domain' | 'captcha_key'

function getFrontendKey(key: FrontendConfigKey): string {
  return getRightKey(key)
}

function getUrl(key: 'api_domain' | 'base_domain' = 'base_domain'): string {
  if (branch === 'local')
    return `http://${getFrontendKey(key)}`
  else
    return `https://${getFrontendKey(key)}`
}

interface FaviconTheme {
  iconPrefix: string
  maskColor: string
  themeColor: string
}

const productionFaviconTheme: FaviconTheme = {
  iconPrefix: '',
  maskColor: '#001827',
  themeColor: '#ffffff',
}

const faviconThemes: Record<string, FaviconTheme> = {
  main: productionFaviconTheme,
  prod: productionFaviconTheme,
  production: productionFaviconTheme,
  development: {
    iconPrefix: '-development',
    maskColor: '#119eff',
    themeColor: '#119eff',
  },
  alpha: {
    iconPrefix: '-development',
    maskColor: '#119eff',
    themeColor: '#119eff',
  },
  preprod: {
    iconPrefix: '-preprod',
    maskColor: '#f59e0b',
    themeColor: '#f59e0b',
  },
  local: {
    iconPrefix: '-local',
    maskColor: '#22c55e',
    themeColor: '#22c55e',
  },
}

function getFaviconTheme(isLocalDevServer = false): FaviconTheme {
  const branchTheme = faviconThemes[branch]
  // Plain `bun run dev` keeps branch=main and points at live config.
  if (isLocalDevServer && (!branchTheme || branchTheme === productionFaviconTheme))
    return faviconThemes.development

  return branchTheme ?? productionFaviconTheme
}

function normalizeDevServerPath(url: string | undefined) {
  const requestPath = (url ?? '').split('?')[0]
  if (requestPath.length > 1 && requestPath.endsWith('/'))
    return requestPath.slice(0, -1)
  return requestPath
}

function wellKnownPasswordManagerPlugin(): Plugin {
  const changePasswordPath = '/.well-known/change-password'
  const probePath = '/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200'

  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const requestPath = normalizeDevServerPath(req.url)
    if (requestPath === changePasswordPath) {
      res.statusCode = 302
      res.setHeader('Location', '/settings/account/change-password')
      res.end()
      return
    }
    if (requestPath === probePath) {
      res.statusCode = 404
      res.end()
      return
    }
    next()
  }

  return {
    name: 'well-known-password-manager',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

function envFaviconPlugin(): Plugin {
  return {
    name: 'capgo-env-favicon',
    transformIndexHtml(html, context) {
      const theme = getFaviconTheme(Boolean(context.server))
      const prefix = theme.iconPrefix

      return html
        .replace('href="/favicon.svg"', `href="/favicon${prefix}.svg"`)
        .replace('href="/favicon.png"', `href="/favicon${prefix}.png"`)
        .replace('href="/pwa-192x192.png"', `href="/pwa${prefix}-192x192.png"`)
        .replace('href="/manifest.webmanifest"', `href="/manifest${prefix}.webmanifest"`)
        .replace('color="#00aba9"', `color="${theme.maskColor}"`)
        .replace('content="#00aba9"', `content="${theme.maskColor}"`)
        .replace('content="#ffffff"', `content="${theme.themeColor}"`)
    },
  }
}

const locales: string[] = []
readdirSync('./messages/')
  .forEach((file) => {
    if (file.split('.')[0] !== 'README')
      locales.push(file.split('.')[0])
  })

const frontendEnvironmentVariables: Record<string, string> = {
  locales: locales.join(','),
  VITE_APP_VERSION: pack.version,
  VITE_APP_URL: getUrl(),
  VITE_API_HOST: getUrl('api_domain'),
  VITE_CAPTCHA_KEY: getFrontendKey('captcha_key'),
  VITE_BRANCH: branch,
  package_dependencies: JSON.stringify(pack.dependencies),
  domain: getUrl(),
}

function frontendEnvironmentPlugin(): Plugin {
  return EnvironmentPlugin(frontendEnvironmentVariables, { defineOn: 'import.meta.env' })
}

export default defineConfig({
  define: {
    __VUE_OPTIONS_API__: 'true',
  },
  resolve: {
    alias: {
      '~/': `${path.resolve(__dirname, 'src')}/`,
      // Workspace plugin: bundle its TypeScript sources so the app never needs its dist build.
      '@capgo/capacitor-notifications': path.resolve(__dirname, 'packages/capacitor-notifications/src/index.ts'),
    },
  },
  build: {
    rolldownOptions: {
      // CI serves a built preview; include browser fixtures only in that test build.
      input: process.env.CAPGO_PLAYWRIGHT_FIXTURES === 'true'
        ? [
            path.resolve(__dirname, 'index.html'),
            path.resolve(__dirname, 'playwright/fixtures/onboarding-setup.html'),
            path.resolve(__dirname, 'playwright/fixtures/email-verification.html'),
          ]
        : undefined,
    },
  },
  plugins: [
    {
      name: 'console-api-only',
      apply: 'build',
      generateBundle() {
        for (const id of this.getModuleIds()) {
          if (/node_modules[\\/].*@supabase[+\\/]/.test(id))
            this.error(`The console must use the Capgo API instead of a Supabase SDK (imported via ${id})`)
        }
      },
    },
    wellKnownPasswordManagerPlugin(),
    envFaviconPlugin(),
    tailwindcss(),
    formkit({}),
    devtoolsJson(),
    VueMacros({
      plugins: {
        vue: Vue({
          include: [/\.vue$/, /\.md$/],
        }),

      },
    }),
    Components({
      extensions: ['vue'],
      // allow auto import and register components used in markdown
      include: [/\.vue$/, /\.vue\?vue/],
      dts: 'src/components.d.ts',
      resolvers: [
        IconsResolver(),
      ],
    }),
    frontendEnvironmentPlugin(),

    // https://github.com/vuejs/router
    VueRouter({
      dts: 'src/route-map.d.ts',
    }),

    // https://github.com/JohnCampionJr/vite-plugin-vue-layouts
    Layouts(),
    // https://github.com/antfu/unplugin-icons
    Icons({
      autoInstall: true,
    }),

    // https://github.com/antfu/unplugin-auto-import
    AutoImport({
      imports: [
        'vue',
        '@vueuse/head',
        '@vueuse/core',
        VueRouterAutoImports,
        {
          // add any other imports you were relying on
          'vue-router/auto': ['useLink'],
        },
      ],
      dts: 'src/auto-imports.d.ts',
      dirs: [
        'src/composables',
        'src/stores',
      ],
      vueTemplate: true,
    }),

    // https://github.com/intlify/bundle-tools/tree/main/packages/unplugin-vue-i18n
    VueI18n({
      module: 'vue-i18n',
      runtimeOnly: true,
      compositionOnly: true,
      fullInstall: true,
      include: [path.resolve(__dirname, 'locales/**')],
    }),

    // https://github.com/webfansplz/vite-plugin-vue-devtools
    VueDevTools({
      componentInspector: false,
    }),
  ],

  server: {
    fs: {
      strict: true,
    },
  },

  optimizeDeps: {
    // Pre-scan the entire app so Playwright does not trigger late dep re-optimization
    // while navigating across lazily loaded routes in the local Vite server.
    entries: [
      'index.html',
      'src/**/*.{vue,ts,js,mts}',
    ],
    include: [
      'vue',
      'vue-router',
      '@vueuse/core',
      '@formkit/core',
      '@formkit/i18n',
      '@formkit/icons',
      '@formkit/vue',
      '@vuepic/vue-datepicker',
      '@capacitor/camera',
      '@capacitor/filesystem',
      'chart.js',
      'country-code-to-flag-emoji',
      'dayjs',
      'dompurify',
      'mime',
      'tailwindcss/colors',
      'vue-chartjs',
      'vue-turnstile',
    ],
    exclude: [
      'vue-demi',
    ],
  },
})

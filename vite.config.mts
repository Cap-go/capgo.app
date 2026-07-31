import { readdirSync } from 'node:fs'
import path from 'node:path'
import VueI18n from '@intlify/unplugin-vue-i18n/vite'
import tailwindcss from '@tailwindcss/vite'
import Vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import formkit from 'unplugin-formkit/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import VueMacros from 'unplugin-vue-macros/vite'
// import veauryVitePlugins from 'veaury/vite/index'
import { defineConfig, type Plugin } from 'vite'
import devtoolsJson from 'vite-plugin-devtools-json'
import EnvironmentPlugin from 'vite-plugin-environment'
import VueDevTools from 'vite-plugin-vue-devtools'
import Layouts from 'vite-plugin-vue-layouts'
import WebfontDownload from 'vite-plugin-webfont-dl'
import { VueRouterAutoImports } from 'vue-router/unplugin'
import VueRouter from 'vue-router/vite'
import pack from './package.json'
import { branch, getRightKey } from './scripts/utils.mjs'
import 'vitest/config'

function getUrl(key = 'base_domain'): string {
  if (branch === 'local')
    return `http://${getRightKey(key)}`
  else
    return `https://${getRightKey(key)}`
}

type FaviconTheme = {
  iconPrefix: string
  maskColor: string
  themeColor: string
}

const productionFaviconTheme: FaviconTheme = {
  iconPrefix: '',
  maskColor: '#00aba9',
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

export default defineConfig({
  define: {
    __VUE_OPTIONS_API__: 'true',
  },
  resolve: {
    alias: {
      '~/': `${path.resolve(__dirname, 'src')}/`,
    },
  },
  plugins: [
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
    EnvironmentPlugin({
      locales: locales.join(','),
      VITE_APP_VERSION: pack.version,
      VITE_SUPABASE_ANON_KEY: getRightKey('supa_anon'),
      VITE_SUPABASE_URL: getRightKey('supa_url'),
      VITE_APP_URL: `${getUrl()}`,
      VITE_API_HOST: `${getUrl('api_domain')}`,
      VITE_CAPTCHA_KEY: getRightKey('captcha_key'),
      VITE_BRANCH: branch,
      package_dependencies: JSON.stringify(pack.dependencies),
      domain: getUrl(),
    }, { defineOn: 'import.meta.env' }),

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

    // https://github.com/feat-agency/vite-plugin-webfont-dl
    WebfontDownload(),

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

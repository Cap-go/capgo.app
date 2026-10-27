import type { IncomingMessage, ServerResponse } from 'node:http'
// import veauryVitePlugins from 'veaury/vite/index'
import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import VueI18n from '@intlify/unplugin-vue-i18n/vite'
import tailwindcss from '@tailwindcss/vite'
import Vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
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
import { isGuestRoutePath } from './src/constants/guestRoutes'
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

// Lazy route chunks normally start downloading only after the entry chunk has run and the router
// matched the URL: a second round of latency on every cold load. This emits a tiny classic script
// (inline scripts are blocked by the CSP) that index.html fetches in parallel with the entry; it adds
// modulepreload links for the page and layout chunks of the URL being opened.
const pagesDir = path.resolve(__dirname, 'src/pages')
const layoutsDir = path.resolve(__dirname, 'src/layouts')

// `segments` are path parts where a leading ':' marks a parameter.
function toRoutePattern(segments: string[]) {
  const parts = segments.map(segment => segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  return {
    source: `^/${parts.join('/')}/?$`,
    params: segments.filter(segment => segment.startsWith(':')).length,
    path: `/${segments.join('/')}`,
  }
}

function fileRoutePattern(file: string) {
  const segments: string[] = []
  for (const segment of path.relative(pagesDir, file).replace(/\.vue$/, '').split(/[\\/.]/)) {
    if (segment === 'index')
      continue
    if (segment.startsWith('[...'))
      return null
    segments.push(segment.startsWith('[') ? `:${segment.slice(1, -1)}` : segment)
  }
  return toRoutePattern(segments)
}

/** Reads `key: value` lines from a page's `<route>` YAML block. */
function routeBlockValue(file: string, key: string) {
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf('<route')
  const end = source.indexOf('</route>', start)
  if (start === -1 || end === -1)
    return undefined
  for (const line of source.slice(start, end).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(`${key}:`))
      return trimmed.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

function routeLayouts(file: string, routePath: string) {
  if (isGuestRoutePath(routePath))
    return ['naked']
  const layout = routeBlockValue(file, 'layout') ?? 'default'
  // The app and settings layouts render inside the default dashboard shell.
  return layout === 'app' || layout === 'settings' ? [layout, 'default'] : [layout]
}

function routeChunkPreloadPlugin(): Plugin {
  return {
    name: 'capgo-route-chunk-preload',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle) {
        const html = bundle['index.html']
        if (html?.type !== 'asset')
          return
        const chunks = Object.values(bundle).filter(item => item.type === 'chunk')
        const byModule = new Map(chunks.filter(chunk => chunk.facadeModuleId).map(chunk => [chunk.facadeModuleId!.split('?')[0], chunk]))
        const entryFiles = new Set<string>()
        for (const chunk of chunks.filter(chunk => chunk.isEntry)) {
          entryFiles.add(chunk.fileName)
          chunk.imports.forEach(file => entryFiles.add(file))
        }
        const byFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
        const closure = (start: string[]) => {
          const files = new Set<string>()
          const stack = [...start]
          while (stack.length) {
            const file = stack.pop()!
            if (files.has(file) || entryFiles.has(file))
              continue
            files.add(file)
            stack.push(...(byFile.get(file)?.imports ?? []))
          }
          return [...files]
        }

        const files: string[] = []
        const fileIndex = (file: string) => {
          let index = files.indexOf(file)
          if (index === -1)
            index = files.push(file) - 1
          return index
        }
        const layoutClosures = new Map<string, number[]>()
        const layoutFiles = (layout: string) => {
          if (!layoutClosures.has(layout)) {
            const chunk = byModule.get(path.join(layoutsDir, `${layout}.vue`))
            layoutClosures.set(layout, chunk ? closure([chunk.fileName]).map(fileIndex) : [])
          }
          return layoutClosures.get(layout)!
        }

        const routes: Array<{ pattern: string, params: number, layouts: string[], files: number[] }> = []
        for (const [moduleId, chunk] of byModule) {
          if (!moduleId.startsWith(pagesDir) || !moduleId.endsWith('.vue'))
            continue
          const override = routeBlockValue(moduleId, 'path')
          const pattern = override ? toRoutePattern(override.split('/').filter(Boolean)) : fileRoutePattern(moduleId)
          if (!pattern)
            continue
          const layouts = routeLayouts(moduleId, pattern.path)
          const shared = new Set(layouts.flatMap(layoutFiles))
          routes.push({ pattern: pattern.source, params: pattern.params, layouts, files: closure([chunk.fileName]).map(fileIndex).filter(index => !shared.has(index)) })
        }
        // Static paths win over parameterized ones (/app/new before /app/:app).
        routes.sort((a, b) => a.params - b.params)

        const layoutNames = [...layoutClosures.keys()]
        const data = {
          f: files,
          l: layoutNames.map(name => layoutClosures.get(name)!),
          r: routes.map(route => [route.pattern, route.layouts.map(name => layoutNames.indexOf(name)), route.files]),
        }
        // Escape characters that could end the string or the script when embedded as code.
        const json = JSON.stringify(data).replace(/[<>/\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
        const source = `(function(){var d=${json},p=location.pathname;function a(i){var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href='/'+d.f[i];document.head.appendChild(l)}for(var i=0;i<d.r.length;i++){var r=d.r[i];if(new RegExp(r[0],'i').test(p)){r[1].forEach(function(x){d.l[x].forEach(a)});r[2].forEach(a);return}}})()\n`
        const fileName = `assets/route-preload-${createHash('sha256').update(source).digest('hex').slice(0, 8)}.js`
        this.emitFile({ type: 'asset', fileName, source })
        html.source = String(html.source).replace(/<script type="module"/, `<script async src="/${fileName}"></script>\n  <script type="module"`)
      },
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
    // Every component, including VueTurnstile.vue, uses the Composition API; dropping the
    // Options API removes its runtime from the Vue chunk.
    __VUE_OPTIONS_API__: 'false',
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
      output: {
        codeSplitting: {
          groups: [
            {
              // The English catalog changes far less often than the code: its own chunk stays
              // cached across deploys instead of being re-downloaded with the entry.
              name: 'messages-en',
              test: /[\\/]messages[\\/]en\.json$/,
              priority: 2,
            },
            {
              // unplugin-icons makes every icon its own module, which became 80+ chunks of a few
              // hundred bytes each. Group icons by the pages that use them and merge the small groups.
              name: 'icons',
              test: /^~icons\//,
              entriesAware: true,
              entriesAwareMergeThreshold: 4 * 1024,
              // Icons only import Vue, which is already in the entry chunk.
              includeDependenciesRecursively: false,
              priority: 1,
            },
          ],
        },
      },
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
    routeChunkPreloadPlugin(),
    tailwindcss(),
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
    ],
    exclude: [
      'vue-demi',
    ],
  },
})

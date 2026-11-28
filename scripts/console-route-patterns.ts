// How file-based pages map to URL patterns and layouts. Shared by the route-chunk preload in
// vite.config.mts and the visual diff planner, which must resolve a URL to the same page.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isGuestRoutePath } from '../src/constants/guestRoutes'

export interface RoutePattern {
  source: string
  params: number
  path: string
}

// `segments` are path parts where a leading ':' marks a parameter.
export function toRoutePattern(segments: string[]): RoutePattern {
  const parts = segments.map(segment => segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  return {
    source: `^/${parts.join('/')}/?$`,
    params: segments.filter(segment => segment.startsWith(':')).length,
    path: `/${segments.join('/')}`,
  }
}

/** Returns null for catch-all pages, which match any path. */
export function fileRoutePattern(file: string, pagesDir: string) {
  const relativePath = path.relative(pagesDir, file).replace(/\.vue$/, '')
  // Checked before splitting: the dots of `[...all]` are not path separators.
  if (relativePath.includes('[...'))
    return null
  const segments: string[] = []
  for (const segment of relativePath.split(/[\\/.]/)) {
    if (segment === 'index')
      continue
    segments.push(segment.startsWith('[') ? `:${segment.slice(1, -1)}` : segment)
  }
  return toRoutePattern(segments)
}

/** Reads `key: value` lines from a page's `<route>` YAML block. */
export function routeBlockValue(file: string, key: string) {
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

export function routeLayouts(file: string, routePath: string) {
  if (isGuestRoutePath(routePath))
    return ['naked']
  const layout = routeBlockValue(file, 'layout') ?? 'default'
  // The app and settings layouts render inside the default dashboard shell.
  return layout === 'app' || layout === 'settings' ? [layout, 'default'] : [layout]
}

/** The URL pattern of a page file, honoring a `<route>` path override. */
export function pageRoutePattern(file: string, pagesDir: string) {
  const override = routeBlockValue(file, 'path')
  return override ? toRoutePattern(override.split('/').filter(Boolean)) : fileRoutePattern(file, pagesDir)
}

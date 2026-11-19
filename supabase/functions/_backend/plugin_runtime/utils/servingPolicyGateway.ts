import { parsePluginRegions } from './pluginRegionTargets.ts'

export function servingPolicyStatusBaseUrl(rawTargets: string): string {
  const [target] = parsePluginRegions(rawTargets)
  const url = new URL(target.url)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Plugin gateway must use HTTP or HTTPS')
  return new URL('serving_policy/', new URL('.', url)).href
}

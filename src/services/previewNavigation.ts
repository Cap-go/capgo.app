import type { Router } from 'vue-router'
import { hasNativeConfirmedPreview } from '~/services/previewLinks'

export function routePreviewScan(router: Router, previewUrl: string) {
  const query: Record<string, string> = { preview: previewUrl }
  if (hasNativeConfirmedPreview(previewUrl))
    query.nativeConfirmedPreview = '1'

  return router.push({
    path: '/scan',
    query,
  })
}

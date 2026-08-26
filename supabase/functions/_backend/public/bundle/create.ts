import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId, isValidSemver } from '../../utils/utils.ts'

interface CreateBundleBody {
  app_id: string
  version: string
  external_url: string
  checksum: string
  session_key?: string
  key_id?: string
}

function validateUrlFormat(url: string) {
  if (!url.startsWith('https://')) {
    throw simpleError('invalid_protocol', 'External URL must use HTTPS protocol', { external_url: url })
  }
}

// async function followRedirectsHead(url: string, maxRedirects = 5): Promise<Response> {
//   let currentUrl = url
//   let redirectCount = 0

//   while (redirectCount <= maxRedirects) {
//     const response = await ky.head(currentUrl, {
//       headers: {
//         'User-Agent': 'Capgo-Bundle-Validator/1.0',
//       },
//       timeout: 10000,
//       retry: 2,
//       throwHttpErrors: false, // Don't throw on 3xx status codes
//     })

//     // Check if it's a redirect status
//     if (response.status >= 300 && response.status < 400) {
//       const location = response.headers.get('location')
//       if (!location) {
//         throw simpleError('url_fetch_error', 'Redirect response without location header', {
//           external_url: currentUrl,
//           status: response.status,
//         })
//       }

//       // Handle relative URLs
//       currentUrl = new URL(location, currentUrl).href
//       redirectCount++

//       if (redirectCount > maxRedirects) {
//         throw simpleError('url_fetch_error', 'Too many redirects', {
//           external_url: url,
//           finalUrl: currentUrl,
//           redirectCount,
//         })
//       }
//       continue
//     }

//     // Not a redirect, return the response
//     return response
//   }

//   throw simpleError('url_fetch_error', 'Unexpected error in redirect handling', {
//     external_url: url,
//   })
// }

// async function verifyUrlAccessibility(url: string): Promise<void> {
//   try {
//     const response = await followRedirectsHead(url)

//     if (!response.ok) {
//       throw simpleError('url_not_accessible', 'External URL is not accessible', {
//         external_url: url,
//         status: response.status,
//         statusText: response.statusText,
//         finalUrl: response.url,
//       })
//     }

//     const contentType = response.headers.get('content-type') || ''
//     const contentLength = response.headers.get('content-length')

//     // Check if it's likely a file (not HTML page)
//     if (contentType.includes('text/html')) {
//       throw simpleError('url_not_file', 'External URL appears to be a webpage, not a file', {
//         external_url: url,
//         contentType,
//       })
//     }

//     // Check if it's a zip file
//     const isZipContentType = contentType.includes('application/zip')
//       || contentType.includes('application/x-zip-compressed')
//       || contentType.includes('application/octet-stream')
//     const isZipExtension = url.toLowerCase().endsWith('.zip')

//     // Check Content-Disposition header for filename
//     const contentDisposition = response.headers.get('content-disposition') || ''
//     const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
//     const filename = filenameMatch ? filenameMatch[1].replace(/['"]/g, '') : ''
//     const isZipFilename = filename.toLowerCase().endsWith('.zip')

//     if (!isZipContentType && !isZipExtension && !isZipFilename) {
//       throw simpleError('url_not_zip', 'External URL must point to a ZIP file', {
//         external_url: url,
//         contentType,
//         contentDisposition,
//         detectedFilename: filename,
//       })
//     }

//     // Check if file has content
//     if (contentLength === '0') {
//       throw simpleError('url_empty_file', 'External URL points to an empty file', {
//         external_url: url,
//       })
//     }
//   }
//   catch (error) {
//     if (error instanceof Error && (error.message.includes('url_not_accessible') || error.message.includes('url_not_file') || error.message.includes('url_empty_file'))) {
//       throw error
//     }
//     throw simpleError('url_fetch_error', 'Failed to verify external URL accessibility', {
//       external_url: url,
//       error: error instanceof Error ? error.message : 'Unknown error',
//     })
//   }
// }

interface AppWithOrg {
  owner_org: string
  orgs: {
    enforce_encrypted_bundles: boolean
    required_encryption_key: string | null
  }
}

async function getAppOrganization(c: Context, appId: string): Promise<AppWithOrg> {
  // Use supabaseAdmin to access org security settings (RLS bypass needed for enforcement check)
  const { data: app, error: appError } = await supabaseAdmin(c)
    .from('apps')
    .select('owner_org, orgs!inner(enforce_encrypted_bundles, required_encryption_key)')
    .eq('app_id', appId)
    .single()

  if (appError || !app) {
    throw simpleError('cannot_find_app', 'Cannot find app', { supabaseError: appError })
  }

  return app as unknown as AppWithOrg
}

async function checkVersionExists(c: Context, appId: string, apikey: Database['public']['Tables']['apikeys']['Row'], version: string): Promise<void> {
  const { data: existingVersion } = await supabaseApikey(c, apikey.key)
    .from('app_versions')
    .select('id')
    .eq('app_id', appId)
    .eq('name', version)
    .eq('deleted', false)
    .single()

  if (existingVersion) {
    throw simpleError('version_already_exists', 'Version already exists', { version })
  }
}

function checkEncryptedBundleEnforcement(appWithOrg: AppWithOrg): void {
  // If org doesn't enforce encrypted bundles, allow
  if (!appWithOrg.orgs.enforce_encrypted_bundles) {
    return
  }

  // POST /bundle only registers external_url rows (storage_provider: external).
  // Org enforcement requires server-verifiable encryption; Capgo never fetches
  // customer URLs (SSRF), so caller-supplied session_key/key_id is not proof.
  // Clients must use direct upload (CLI bundle upload without -e) instead.
  // Version gating would preserve the bypass for older API clients.
  throw simpleError('encryption_required', 'This organization requires all bundles to be encrypted. External URL bundles cannot be used because Capgo cannot verify their encryption. Upload the bundle directly instead.', {
    enforce_encrypted_bundles: true,
    external_url: true,
  })
}

async function insertBundle(c: Context, body: CreateBundleBody, ownerOrg: string, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<any> {
  const { data: newBundle, error: createError } = await supabaseApikey(c, apikey.key)
    .from('app_versions')
    .insert({
      app_id: body.app_id,
      checksum: body.checksum,
      name: body.version,
      ...(body.session_key && { session_key: body.session_key }),
      ...(body.key_id && { key_id: body.key_id }),
      external_url: body.external_url,
      storage_provider: 'external',
      owner_org: ownerOrg,
      user_id: apikey.user_id,
    })
    .select()
    .single()

  if (createError) {
    throw simpleError('cannot_create_bundle', 'Cannot create bundle', { supabaseError: createError })
  }

  return newBundle
}

export async function createBundle(c: Context<MiddlewareKeyVariables>, body: CreateBundleBody, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing required fields: app_id', { app_id: body.app_id })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  if (!body.version) {
    throw simpleError('missing_version', 'Missing required fields: version', { version: body.version })
  }
  if (!body.external_url) {
    throw simpleError('missing_external_url', 'Missing required fields: external_url', { external_url: body.external_url })
  }
  if (!body.checksum) {
    throw simpleError('missing_checksum', 'Missing required fields: checksum', { checksum: body.checksum })
  }
  if (!isValidSemver(body.version)) {
    throw simpleError('invalid_version_format', 'Version must be valid semver format (e.g., 1.0.0, 1.0.0-alpha.1)', { version: body.version })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id }))) {
    throw simpleError('cannot_create_bundle', 'You can\'t access this app', { app_id: body.app_id })
  }

  validateUrlFormat(body.external_url)
  // await verifyUrlAccessibility(body.external_url)

  const appWithOrg = await getAppOrganization(c, body.app_id)

  // Check encrypted bundle enforcement
  checkEncryptedBundleEnforcement(appWithOrg)

  await checkVersionExists(c, body.app_id, apikey, body.version)

  const newBundle = await insertBundle(c, body, appWithOrg.owner_org, apikey)

  return c.json({
    status: 'success',
    bundle: newBundle,
  })
}

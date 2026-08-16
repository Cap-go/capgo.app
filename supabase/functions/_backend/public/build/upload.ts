import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'

/**
 * TUS proxy for builder uploads
 * This proxies TUS protocol requests (POST, HEAD, PATCH, OPTIONS) to the builder,
 * adding the builder API key in the header so it never leaks to the client.
 */
export async function tusProxy(
  c: Context,
  jobId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  forwardMethod = c.req.method,
): Promise<Response> {
  cloudlog({
    requestId: c.get('requestId'),
    message: 'TUS proxy request',
    job_id: jobId,
    method: c.req.method,
    forward_method: forwardMethod,
  })

  // Get builder config
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')

  if (!builderUrl || !builderApiKey) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder not configured for TUS proxy',
      job_id: jobId,
    })
    throw quickError(503, 'service_unavailable', 'Builder service not configured')
  }

  // Use authenticated client for data queries - RLS will enforce access
  const supabase = supabaseApikey(c, apikey.key)

  // Get build request to verify ownership and that the upload window is still open
  const { data: buildRequest, error: buildRequestError } = await supabase
    .from('build_requests')
    .select('app_id, owner_org, builder_job_id, upload_path, upload_expires_at, status')
    .eq('builder_job_id', jobId)
    .single()

  if (buildRequestError || !buildRequest) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Build request not found',
      job_id: jobId,
      error: buildRequestError,
    })
    throw simpleError('not_found', 'Build request not found')
  }

  // Fail closed: only `pending` is the upload window (set in request.ts).
  // After /build/start the row moves to running/terminal and must not accept more bytes.
  if (!buildRequest.status || buildRequest.status !== 'pending') {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'TUS upload rejected for non-pending build status',
      job_id: jobId,
      status: buildRequest.status,
    })
    throw quickError(403, 'upload_not_allowed', 'Upload is not allowed for this build status')
  }

  if (!buildRequest.upload_expires_at) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'TUS upload rejected: missing upload_expires_at',
      job_id: jobId,
    })
    throw quickError(403, 'upload_expired', 'Upload window has expired')
  }

  const uploadExpiresAt = new Date(buildRequest.upload_expires_at)
  if (Number.isNaN(uploadExpiresAt.getTime()) || uploadExpiresAt.getTime() <= Date.now()) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'TUS upload rejected: upload window expired',
      job_id: jobId,
      upload_expires_at: buildRequest.upload_expires_at,
    })
    throw quickError(403, 'upload_expired', 'Upload window has expired')
  }

  // Check if user has permission to upload for this build (auth context set by middlewareKey)
  if (!(await checkPermission(c, 'app.build_native', { appId: buildRequest.app_id }))) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unauthorized TUS upload',
      job_id: jobId,
      app_id: buildRequest.app_id,
      user_id: apikey.user_id,
    })
    throw simpleError('unauthorized', 'You do not have permission to upload for this build')
  }

  // Validate upload_path structure
  // Expected format: orgs/${org_id}/apps/${app_id}/native-builds/${upload_session_key}.zip
  if (!buildRequest.upload_path) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Missing upload_path in build request',
      job_id: jobId,
      app_id: buildRequest.app_id,
    })
    throw simpleError('invalid_request', 'Build request missing upload path')
  }

  const pathPattern = /^orgs\/[^/]+\/apps\/[^/]+\/native-builds\/[^/]+\.zip$/
  if (!pathPattern.test(buildRequest.upload_path)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Invalid upload_path format',
      job_id: jobId,
      upload_path: buildRequest.upload_path,
    })
    throw simpleError('invalid_request', 'Invalid upload path format')
  }

  // Verify the upload_path contains the correct app_id and org_id
  const expectedPathPrefix = `orgs/${buildRequest.owner_org}/apps/${buildRequest.app_id}/native-builds/`
  if (!buildRequest.upload_path.startsWith(expectedPathPrefix)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Upload path does not match org/app from build request',
      job_id: jobId,
      upload_path: buildRequest.upload_path,
      expected_prefix: expectedPathPrefix,
      app_id: buildRequest.app_id,
      owner_org: buildRequest.owner_org,
    })
    throw simpleError('invalid_request', 'Upload path does not match build request')
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Upload path validated',
    job_id: jobId,
    upload_path: buildRequest.upload_path,
  })

  // Extract the path after /upload/:jobId/ and bind it to this job's upload resource
  // Example: /build/upload/abc123/myfile.zip -> /upload/myfile.zip
  // Example: /build/upload/abc123 -> /upload/
  const requestUrl = c.req.raw.url
  const requestPathStart = requestUrl.includes('://')
    ? requestUrl.indexOf('/', requestUrl.indexOf('://') + 3)
    : requestUrl.indexOf('/')
  const originalPath = requestPathStart >= 0
    ? requestUrl.slice(requestPathStart).split('?')[0].split('#')[0]
    : '/'
  const uploadPrefix = `/build/upload/${jobId}`
  let tusPath = '/'
  if (originalPath.startsWith(`${uploadPrefix}/`)) {
    tusPath = originalPath.slice(uploadPrefix.length)
  }

  let decodedTusPath: string
  try {
    decodedTusPath = decodeURIComponent(tusPath)
  }
  catch {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Invalid URL encoding in upload path',
      job_id: jobId,
      original_path: originalPath,
      upload_path: tusPath,
    })
    throw quickError(400, 'invalid_path', 'Invalid upload path encoding.')
  }

  const hasDotSegment = decodedTusPath
    .split('/')
    .some(segment => segment === '.' || segment === '..')

  if (decodedTusPath.includes('\0') || hasDotSegment) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Rejected upload path traversal attempt',
      job_id: jobId,
      original_path: originalPath,
      upload_path: decodedTusPath,
    })
    throw quickError(400, 'invalid_path', 'Invalid upload path')
  }

  const clientSuffix = decodedTusPath.replace(/^\/+|\/+$/g, '')
  const jobUploadResource = buildRequest.upload_path.split('/').filter(Boolean).at(-1)
  if (!jobUploadResource) {
    throw simpleError('invalid_request', 'Invalid upload path format')
  }

  // POST creates this job's upload only. Never forward a client-chosen extra segment.
  if (forwardMethod === 'POST' && clientSuffix) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Rejected POST with extra TUS path segment',
      job_id: jobId,
      original_path: originalPath,
      upload_path: decodedTusPath,
    })
    throw quickError(400, 'invalid_path', 'Upload create path must not include a TUS resource id.')
  }

  // PATCH/HEAD/OPTIONS may send a Location suffix. Bind it to this job's upload_path
  // (last segment or the full stored path). Anything else is another job's resource.
  if (forwardMethod !== 'POST' && clientSuffix
    && clientSuffix !== jobUploadResource
    && clientSuffix !== buildRequest.upload_path) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Rejected TUS path that does not belong to this job',
      job_id: jobId,
      original_path: originalPath,
      upload_path: decodedTusPath,
    })
    throw quickError(400, 'invalid_path', 'Upload path does not match this build request')
  }

  const boundTusPath = forwardMethod === 'POST'
    ? '/'
    : `/${clientSuffix === buildRequest.upload_path ? buildRequest.upload_path : jobUploadResource}`

  const baseUploadUrl = new URL(`${builderUrl}/upload/`)
  const resolvedTusUrl = new URL(`.${boundTusPath}`, baseUploadUrl)
  if (!resolvedTusUrl.pathname.startsWith(baseUploadUrl.pathname)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Rejected upload path escape attempt',
      job_id: jobId,
      original_path: originalPath,
      resolved_path: resolvedTusUrl.pathname,
      builder_path: baseUploadUrl.pathname,
    })
    throw quickError(400, 'invalid_path', 'Resolved upload path escapes upload directory.')
  }

  // Construct builder TUS URL with the path
  const safeTusPath = resolvedTusUrl.pathname.slice(baseUploadUrl.pathname.length - 1)
  const builderTusUrl = resolvedTusUrl.toString()

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Proxying TUS request to builder',
    job_id: jobId,
    method: c.req.method,
    forward_method: forwardMethod,
    original_path: originalPath,
    upload_prefix: uploadPrefix,
    tus_path: safeTusPath,
    builder_url: builderTusUrl,
    has_api_key: !!builderApiKey,
  })

  // Forward the request to builder with API key
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-api-key', builderApiKey)

  // For POST requests, rewrite Upload-Metadata to use the correct artifact key
  // Use the upload_path from the build request which contains the full orgs/apps path structure
  // Example: orgs/${org_id}/apps/${app_id}/native-builds/${upload_session_key}.zip
  if (forwardMethod === 'POST') {
    const artifactKey = buildRequest.upload_path

    // Parse existing Upload-Metadata header to preserve other fields like filetype
    // Format: "key1 base64value1,key2 base64value2"
    const existingMetadata = c.req.header('upload-metadata') || ''
    const metadataFields: string[] = []

    // Parse existing metadata and preserve non-filename fields
    if (existingMetadata) {
      const pairs = existingMetadata.split(',').map(p => p.trim())
      for (const pair of pairs) {
        const [key] = pair.split(' ', 1)
        // Keep all fields except filename (we'll replace it)
        if (key !== 'filename') {
          metadataFields.push(pair)
        }
      }
    }

    // Add the new filename
    const encodedFilename = btoa(artifactKey)
    metadataFields.unshift(`filename ${encodedFilename}`) // Put filename first

    const newMetadata = metadataFields.join(',')
    headers.set('upload-metadata', newMetadata)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Rewrote Upload-Metadata for builder',
      job_id: jobId,
      artifact_key: artifactKey,
      original_metadata: existingMetadata,
      new_metadata: newMetadata,
    })
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Request headers prepared for builder',
    job_id: jobId,
    has_x_api_key: headers.has('x-api-key'),
  })

  // Forward the request
  const forwardInit: RequestInit = {
    method: forwardMethod,
    headers,
  }

  if (forwardMethod !== 'HEAD' && forwardMethod !== 'GET') {
    forwardInit.body = c.req.raw.body
    // @ts-expect-error - duplex is valid for streaming
    forwardInit.duplex = 'half'
  }

  const builderResponse = await fetch(builderTusUrl, forwardInit)

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Builder TUS response',
    job_id: jobId,
    status: builderResponse.status,
  })

  // Rewrite Location header if present (for POST responses)
  const responseHeaders = new Headers(builderResponse.headers)
  const locationHeader = builderResponse.headers.get('location')

  if (locationHeader) {
    // Replace builder URL with proxy URL
    // Example: https://builder.capgo.app/upload/file.zip -> https://api.capgo.app/build/upload/:jobId/file.zip
    try {
      const locationUrl = new URL(locationHeader)
      const builderUrlObj = new URL(builderUrl)

      // Check if this is a builder URL
      if (locationUrl.host === builderUrlObj.host) {
        // Extract path after /upload/
        const builderUploadPath = baseUploadUrl.pathname.endsWith('/')
          ? baseUploadUrl.pathname.slice(0, -1)
          : baseUploadUrl.pathname
        const uploadPath = locationUrl.pathname.startsWith(builderUploadPath)
          ? locationUrl.pathname.slice(builderUploadPath.length) || '/'
          : locationUrl.pathname

        // Construct proxy URL
        const publicUrl = getEnv(c, 'PUBLIC_URL') || 'https://api.capgo.app'
        const proxyLocation = `${publicUrl}/build/upload/${jobId}${uploadPath}`

        responseHeaders.set('location', proxyLocation)

        cloudlog({
          requestId: c.get('requestId'),
          message: 'Rewrote Location header',
          original: locationHeader,
          rewritten: proxyLocation,
        })
      }
    }
    catch (e) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to rewrite Location header',
        location: locationHeader,
        error: (e as Error).message,
      })
    }
  }

  // Return builder response to client
  return new Response(builderResponse.body, {
    status: builderResponse.status,
    headers: responseHeaders,
  })
}

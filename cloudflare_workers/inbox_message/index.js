// Placeholder for the virtual inbox RPC. No upstream request is made.
export default {
  async fetch(request) {
    const headers = new Headers({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, x-supabase-api-version',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })

    return new Response(request.method === 'OPTIONS' ? null : '{"message":null}', {
      status: 200,
      headers,
    })
  },
}

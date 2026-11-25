// Cloudflare Snippet on the capgo.app zone, pasted by hand like
// legacy_cli_manifest_warning. Turn it on right after the auth cutover deploys.
// Rule: (http.host eq "sb.capgo.app" and starts_with(http.request.uri.path, "/auth/v1/"))
//
// Supabase Auth's public URL (email links, SAML ACS and metadata) goes to our
// GoTrue through the API's auth relay; the rest of sb.capgo.app stays on
// hosted Supabase. Same method, query and body; GoTrue's redirects go back to
// the browser untouched.
export default {
  async fetch(request) {
    const url = new URL(request.url)
    url.hostname = 'api.capgo.app'
    url.pathname = `/private/console/auth/${url.pathname.slice('/auth/v1/'.length)}`
    return fetch(new Request(url, request), { redirect: 'manual' })
  },
}

import { exit } from 'node:process'

// Same request as supabase-js `auth.admin.generateLink`, returned in its
// { properties, user } shape.
async function generateLink(supabaseUrl, serviceKey, params) {
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const body = await response.json().then(json => json ?? {}, () => ({}))
  if (!response.ok)
    return { data: null, error: { status: response.status, message: body.msg || body.message || body.error_description || body.error || `HTTP ${response.status}` } }
  const { action_link, email_otp, hashed_token, redirect_to, verification_type, ...user } = body
  return { data: { properties: { action_link, email_otp, hashed_token, redirect_to, verification_type }, user }, error: null }
}

async function run() {
  // Get email from command line arguments
  const email = process.argv[2]

  if (!email) {
    console.error('Usage: node generate_magic_link.mjs email@example.com')
    exit(1)
  }

  // Load environment variables

  const supabaseUrl = '***'
  const supabaseServiceKey = '***'

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
    exit(1)
  }

  try {
    console.log(`Generating magic link for ${email}...`)

    // Generate magic link
    const { data: magicLink, error: magicError } = await generateLink(supabaseUrl, supabaseServiceKey, {
      type: 'magiclink',
      email,
    })

    if (magicError) {
      console.error('Error generating magic link:', magicError)
      exit(1)
    }

    console.log('\n=== Magic Link Generated Successfully ===')
    console.log(`Email: ${email}`)
    console.log(`Magic Link URL: ${magicLink.properties.action_link}`)
    console.log(`Hashed Token: ${magicLink.properties.hashed_token}`)
    console.log(`Expires At: ${new Date(magicLink.properties.created_at).toLocaleString()}`)
  }
  catch (error) {
    console.error('Unexpected error:', error)
    exit(1)
  }
}

run().catch(console.error)

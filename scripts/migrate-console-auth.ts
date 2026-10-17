import { createDecipheriv, hkdfSync } from 'node:crypto'
import { symmetricEncrypt } from 'better-auth/crypto'
import pg from 'pg'
import { consoleSamlConfig } from '../supabase/functions/_backend/utils/console_sso'

// Run against a restored backup first. Dry-run is the default; no secrets or
// account identifiers are printed. Existing Better Auth credentials are never overwritten.
const apply = process.argv.includes('--apply')
const secret = process.env.BETTER_AUTH_SECRET ?? ''
if (secret.length < 32 || !process.env.SUPABASE_DB_URL)
  throw new Error('SUPABASE_DB_URL and BETTER_AUTH_SECRET (32+ characters) are required')
const decryptionKeys = JSON.parse(process.env.GOTRUE_SECURITY_DB_ENCRYPTION_DECRYPTION_KEYS ?? '{}') as Record<string, string>

function decrypt(value: string, id: string): string {
  if (!value.startsWith('{'))
    return value
  const encrypted = JSON.parse(value)
  const key = decryptionKeys[encrypted.key_id]
  if (encrypted.alg !== 'aes-gcm-hkdf' || !key)
    throw new Error('Source authentication encryption key is required')
  const derived = hkdfSync('sha256', Buffer.from(key, 'base64url'), Buffer.alloc(0), id, 32)
  const ciphertext = Buffer.from(encrypted.data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(encrypted.nonce, 'base64'))
  decipher.setAuthTag(ciphertext.subarray(-16))
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8')
}

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 1 })
try {
  const duplicates = await pool.query(`SELECT 1 FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL
    GROUP BY lower(email) HAVING count(*) > 1 LIMIT 1`)
  if (duplicates.rowCount)
    throw new Error('Duplicate email identities must be reconciled before migration')
  const unsupported = await pool.query(`SELECT 1 FROM auth.mfa_factors WHERE status = 'verified'
    GROUP BY user_id HAVING count(*) > 1 OR bool_or(factor_type <> 'totp') LIMIT 1`)
  if (unsupported.rowCount)
    throw new Error('Multiple factors or non-TOTP factors require an explicit migration before cutover')

  const providers = await pool.query(`SELECT p.provider_id, p.domain, p.org_id, p.status, o.created_by,
    a.metadata_xml, a.attribute_mapping FROM public.sso_providers p
    JOIN public.orgs o ON o.id = p.org_id LEFT JOIN auth.saml_providers a ON a.sso_provider_id::text = p.provider_id
    WHERE p.provider_id IS NOT NULL`)
  const providerConfigs = providers.rows.map((provider) => {
    if (!process.env.CONSOLE_AUTH_URL || !provider.metadata_xml || !provider.created_by)
      throw new Error('SSO migration requires CONSOLE_AUTH_URL, stored IdP metadata, and an organization owner')
    const mapping = Object.fromEntries(Object.entries(provider.attribute_mapping?.keys ?? {}).map(([key, value]: [string, any]) => {
      if (typeof value.name !== 'string')
        throw new Error('Unsupported SSO attribute mapping; reconcile before cutover')
      return [key, value.name]
    }))
    return { ...provider, config: consoleSamlConfig(process.env.CONSOLE_AUTH_URL, provider.provider_id, provider.metadata_xml, mapping) }
  })

  let after = '00000000-0000-0000-0000-000000000000'
  let users = 0
  let factors = 0
  for (;;) {
    const { rows } = await pool.query(`SELECT u.*, f.id AS factor_id, f.secret AS factor_secret
      FROM auth.users u LEFT JOIN auth.mfa_factors f ON f.user_id = u.id AND f.status = 'verified'
      WHERE u.id > $1::uuid AND u.email IS NOT NULL AND u.deleted_at IS NULL ORDER BY u.id LIMIT 500`, [after])
    if (!rows.length)
      break
    for (const user of rows) {
      const password = user.encrypted_password ? decrypt(user.encrypted_password, user.id) : null
      if (password && !/^\$2[aby]\$/.test(password))
        throw new Error('Unsupported password hash; migration stopped')
      const totp = user.factor_secret ? decrypt(user.factor_secret, user.factor_id) : null
      if (totp && !/^[A-Z2-7]+=*$/i.test(totp))
        throw new Error('Unsupported TOTP secret; migration stopped')
      if (totp)
        factors++
      if (apply) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const inserted = await client.query(`INSERT INTO public.console_auth_user
            (id, name, email, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", "userMetadata", "appMetadata", "migrationBlocked")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [user.id, user.raw_user_meta_data?.name ?? user.email, user.email.toLowerCase(), !!user.email_confirmed_at,
            user.created_at, user.updated_at, !!totp, user.raw_user_meta_data, user.raw_app_meta_data])
          if (inserted.rowCount && password) {
            await client.query(`INSERT INTO public.console_auth_account
              (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
              VALUES ($1, $2, 'credential', $2, $3, now(), now())`, [crypto.randomUUID(), user.id, password])
          }
          if (inserted.rowCount && totp) {
            await client.query(`INSERT INTO public.console_auth_two_factor
              (id, secret, "backupCodes", "userId", verified, "failedVerificationCount") VALUES ($1, $2, $3, $4, true, 0)`,
            [user.factor_id, await symmetricEncrypt({ key: secret, data: `capgo-base32:${totp}` }), await symmetricEncrypt({ key: secret, data: '[]' }), user.id])
          }
          await client.query('COMMIT')
        }
        catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
        finally {
          client.release()
        }
      }
      users++
    }
    after = rows.at(-1).id
  }
  if (apply) {
    for (const provider of providerConfigs) {
      await pool.query(`INSERT INTO public.console_auth_sso_provider
        (id, "providerId", "userId", "organizationId", domain, issuer, "samlConfig")
        VALUES ($1, $1, $2, $3, $4, $5, $6) ON CONFLICT ("providerId") DO NOTHING`,
      [provider.provider_id, provider.created_by, provider.org_id, provider.status === 'active' ? provider.domain : '', provider.config.issuer, JSON.stringify(provider.config)])
    }
  }
  console.log(JSON.stringify({ providers: providerConfigs.length, mode: apply ? 'applied' : 'dry-run', users, factors }))
}
finally {
  await pool.end()
}

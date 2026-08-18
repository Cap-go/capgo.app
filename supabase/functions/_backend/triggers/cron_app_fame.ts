import type { Context } from 'hono'
import type { AppFameCandidate } from '../utils/app_fame.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { AiBinding } from '../utils/workers_ai.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import {
  APP_FAME_BATCH_SIZE,
  APP_FAME_STALE_DAYS,
  scoreAppsWithAi,
} from '../utils/app_fame.ts'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from '../utils/pg.ts'

export const app = new Hono<MiddlewareKeyVariables>()

export async function processAppFameBatch(c: Context<MiddlewareKeyVariables>): Promise<{ scored: number, skipped: number }> {
  const ai = c.env.AI as AiBinding | undefined
  if (!ai) {
    cloudlog({ requestId: c.get('requestId'), message: 'cron_app_fame skipped, Workers AI binding missing' })
    return { scored: 0, skipped: 0 }
  }

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const candidateResult = await drizzleClient.execute(sql`
      SELECT
        a.app_id,
        a.name,
        a.icon_url,
        a.ios_store_url,
        a.android_store_url,
        o.name AS org_name,
        o.website AS org_website
      FROM public.apps AS a
      JOIN public.orgs AS o ON o.id = a.owner_org
      LEFT JOIN public.app_fame AS f ON f.app_id = a.app_id
      WHERE a.app_id NOT LIKE 'com.demo.%'
        AND a.app_id NOT LIKE 'com.capdemo.%'
        AND (
          f.app_id IS NULL
          OR f.checked_at < now() - make_interval(days => ${APP_FAME_STALE_DAYS})
        )
      ORDER BY
        CASE
          WHEN COALESCE(a.ios_store_url, '') <> '' OR COALESCE(a.android_store_url, '') <> '' THEN 0
          ELSE 1
        END,
        f.checked_at NULLS FIRST,
        a.created_at ASC
      LIMIT ${APP_FAME_BATCH_SIZE}
    `)

    const candidates: AppFameCandidate[] = candidateResult.rows.map((row: any) => ({
      app_id: String(row.app_id || ''),
      name: row.name ?? null,
      icon_url: row.icon_url ?? null,
      ios_store_url: row.ios_store_url ?? null,
      android_store_url: row.android_store_url ?? null,
      org_name: row.org_name ?? null,
      org_website: row.org_website ?? null,
    })).filter(row => row.app_id.length > 0)

    if (candidates.length === 0)
      return { scored: 0, skipped: 0 }

    const { decisions, model } = await scoreAppsWithAi(c, ai, candidates)
    if (decisions.length === 0) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'cron_app_fame AI returned no usable scores',
        candidateCount: candidates.length,
        model,
      })
      return { scored: 0, skipped: candidates.length }
    }

    for (const decision of decisions) {
      await drizzleClient.execute(sql`
        INSERT INTO public.app_fame (
          app_id,
          fame_score,
          confidence,
          tier,
          category,
          known_as,
          summary,
          model,
          checked_at,
          updated_at
        ) VALUES (
          ${decision.app_id},
          ${decision.fame_score},
          ${decision.confidence},
          ${decision.tier},
          ${decision.category || null},
          ${decision.known_as || null},
          ${decision.summary},
          ${model},
          now(),
          now()
        )
        ON CONFLICT (app_id) DO UPDATE SET
          fame_score = EXCLUDED.fame_score,
          confidence = EXCLUDED.confidence,
          tier = EXCLUDED.tier,
          category = EXCLUDED.category,
          known_as = EXCLUDED.known_as,
          summary = EXCLUDED.summary,
          model = EXCLUDED.model,
          checked_at = EXCLUDED.checked_at,
          updated_at = EXCLUDED.updated_at
      `)
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'cron_app_fame scored apps',
      scored: decisions.length,
      skipped: candidates.length - decisions.length,
      model,
    })

    return { scored: decisions.length, skipped: candidates.length - decisions.length }
  }
  catch (error) {
    logPgError(c, 'processAppFameBatch', error)
    throw error
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
}

app.post('/', middlewareAPISecret, async (c) => {
  cloudlog({ requestId: c.get('requestId'), message: 'cron_app_fame start' })
  const result = await processAppFameBatch(c)
  if (result.scored === 0 && result.skipped === 0)
    return c.json(BRES)
  return c.json({ status: 'ok', ...result })
})

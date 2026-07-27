import type Stripe from 'stripe'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { getAdminBuilderAnalytics } from '../utils/builder_analytics.ts'
import { getAdminAppsTrend, getAdminBandwidthTrend, getAdminBundlesTrend, getAdminDistributionMetrics, getAdminFailureMetrics, getAdminMauTrend, getAdminOrgMetrics, getAdminPlatformOverview, getAdminStorageTrend, getAdminSuccessRate, getAdminSuccessRateTrend, getAdminUploadMetrics } from '../utils/cloudflare.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { getAdminCancelledOrganizations, getAdminCustomerCountryBreakdown, getAdminDeploymentsTrend, getAdminEmailTypeBreakdown, getAdminGlobalStatsTrend, getAdminOnboardingFunnel, getAdminOrganizationInsights, getAdminPluginBreakdown, getAdminTrialOrganizations, getAdminTrialPlanBreakdown } from '../utils/pg.ts'
import { getCancellationDetails } from '../utils/stripe.ts'
import { supabaseClient as useSupabaseClient } from '../utils/supabase.ts'

export const MAX_ADMIN_STATS_LIMIT = 50_000
export const MAX_ADMIN_STATS_OFFSET = 100_000
const ISO_UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const INVALID_ADMIN_STATS_DATE = 'Expected ISO 8601 UTC datetime string'

const metricCategories = [
  'uploads',
  'distribution',
  'failures',
  'success_rate',
  'platform_overview',
  'org_metrics',
  'mau_trend',
  'success_rate_trend',
  'apps_trend',
  'bundles_trend',
  'deployments_trend',
  'storage_trend',
  'bandwidth_trend',
  'global_stats_trend',
  'plugin_breakdown',
  'trial_organizations',
  'trial_plan_breakdown',
  'onboarding_funnel',
  'cancelled_users',
  'email_type_breakdown',
  'customer_country_breakdown',
  'organization_insights',
  'builder_analytics',
] as const

const isoUtcDatetimeSchema = z.string().refine(
  value => value.length > 0 && ISO_UTC_DATETIME_REGEX.test(value),
  { message: INVALID_ADMIN_STATS_DATE },
)

const limitSchema = z.number().int().min(1).refine(
  value => value <= MAX_ADMIN_STATS_LIMIT,
  { message: `a value <= ${MAX_ADMIN_STATS_LIMIT}` },
)

const offsetSchema = z.number().int().min(0).refine(
  value => value <= MAX_ADMIN_STATS_OFFSET,
  { message: `a value <= ${MAX_ADMIN_STATS_OFFSET}` },
)

export const adminStatsBodySchema = z.object({
  metric_category: z.enum(metricCategories),
  start_date: isoUtcDatetimeSchema,
  end_date: isoUtcDatetimeSchema,
  app_id: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  plan_name: z.string().max(128).optional(),
  billing_type: z.enum(['monthly', 'yearly']).optional(),
  paid_only: z.boolean().optional(),
  search: z.string().max(128).optional(),
  limit: limitSchema.optional(),
  offset: offsetSchema.optional(),
})

interface AdminStatsBody {
  metric_category: string
  start_date: string
  end_date: string
  app_id?: string
  org_id?: string
  plan_name?: string
  billing_type?: 'monthly' | 'yearly'
  paid_only?: boolean
  search?: string
  limit?: number
  offset?: number
}

type CancellationDetails = Stripe.Subscription.CancellationDetails

const cancellationFeedbackLabels: Record<string, string> = {
  customer_service: 'Customer service',
  low_quality: 'Low quality',
  missing_features: 'Missing features',
  other: 'Other',
  switched_service: 'Switched service',
  too_complex: 'Too complex',
  too_expensive: 'Too expensive',
  unused: 'Unused',
}

const cancellationReasonLabels: Record<string, string> = {
  cancellation_requested: 'Cancellation requested',
  payment_disputed: 'Payment disputed',
  payment_failed: 'Payment failed',
}

const churnReasonLabels: Record<string, string> = {
  past_due_unresolved: 'Failed to resolve past due',
}

function formatStoredChurnReason(churnReason: string | null): string | null {
  if (!churnReason)
    return null

  return churnReasonLabels[churnReason] ?? churnReason
}

/**
 * Formats stored churn reasons or Stripe cancellation details into a short label.
 */
function formatCancellationReason(details: CancellationDetails | null, churnReason: string | null): string | null {
  const storedReason = formatStoredChurnReason(churnReason)
  if (storedReason)
    return storedReason

  if (!details)
    return null

  const feedback = details.feedback ? (cancellationFeedbackLabels[details.feedback] ?? details.feedback) : null
  const reason = details.reason ? (cancellationReasonLabels[details.reason] ?? details.reason) : null
  const comment = details.comment?.trim()

  let base = feedback || reason || null
  if (comment)
    base = base ? `${base} — ${comment}` : comment

  return base
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const authToken = c.req.header('authorization')

  if (!authToken)
    throw simpleError('not_authorized', 'Not authorized')

  const body = await parseBody<AdminStatsBody>(c)
  const parsedBodyResult = safeParseSchema(adminStatsBodySchema, body)
  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid json body', { body, parsedBodyResult })
  }

  // Verify user is admin
  const supabaseClient = useSupabaseClient(c, authToken)
  const { data: isAdmin, error: adminError } = await supabaseClient.rpc('is_platform_admin')

  if (adminError) {
    cloudlog({ requestId: c.get('requestId'), message: 'is_admin_error', error: adminError })
    throw simpleError('is_admin_error', 'Is admin error', { adminError })
  }

  if (!isAdmin) {
    cloudlog({ requestId: c.get('requestId'), message: 'not_admin', body })
    throw simpleError('not_admin', 'Not admin - only admin users can access platform statistics')
  }

  const { metric_category, start_date, end_date, app_id, org_id, plan_name, billing_type, paid_only, search, limit, offset } = parsedBodyResult.data

  cloudlog({
    requestId: c.get('requestId'),
    message: 'admin_stats request',
    metric_category,
    start_date,
    end_date,
    app_id,
    org_id,
  })

  try {
    let result

    switch (metric_category) {
      case 'uploads':
        result = await getAdminUploadMetrics(c, start_date, end_date, app_id)
        break

      case 'distribution':
        result = await getAdminDistributionMetrics(c, start_date, end_date, app_id)
        break

      case 'failures':
        result = await getAdminFailureMetrics(c, start_date, end_date, app_id)
        break

      case 'success_rate':
        result = await getAdminSuccessRate(c, start_date, end_date, app_id)
        break

      case 'platform_overview':
        result = await getAdminPlatformOverview(c, start_date, end_date, org_id)
        break

      case 'org_metrics':
        result = await getAdminOrgMetrics(c, start_date, end_date, limit || 100)
        break

      case 'mau_trend':
        result = await getAdminMauTrend(c, start_date, end_date, org_id)
        break

      case 'success_rate_trend':
        result = await getAdminSuccessRateTrend(c, start_date, end_date, app_id)
        break

      case 'apps_trend':
        result = await getAdminAppsTrend(c, start_date, end_date)
        break

      case 'bundles_trend':
        result = await getAdminBundlesTrend(c, start_date, end_date)
        break

      case 'deployments_trend':
        result = await getAdminDeploymentsTrend(c, start_date, end_date, app_id)
        break

      case 'storage_trend':
        result = await getAdminStorageTrend(c, start_date, end_date, app_id)
        break

      case 'bandwidth_trend':
        result = await getAdminBandwidthTrend(c, start_date, end_date, app_id)
        break

      case 'global_stats_trend':
        result = await getAdminGlobalStatsTrend(c, start_date, end_date)
        break

      case 'plugin_breakdown':
        result = await getAdminPluginBreakdown(c, start_date, end_date)
        break

      case 'trial_organizations':
        result = await getAdminTrialOrganizations(c, limit || 20, offset || 0)
        break

      case 'trial_plan_breakdown':
        result = await getAdminTrialPlanBreakdown(c, start_date, end_date)
        break

      case 'cancelled_users': {
        const canceledOrgs = await getAdminCancelledOrganizations(c, start_date, end_date, limit || 20, offset || 0)
        const detailsCache = new Map<string, CancellationDetails | null>()
        const organizations = await Promise.all(
          canceledOrgs.organizations.map(async (org) => {
            let details: CancellationDetails | null = null
            if (org.subscription_id) {
              if (detailsCache.has(org.subscription_id)) {
                details = detailsCache.get(org.subscription_id) ?? null
              }
              else {
                details = await getCancellationDetails(c, org.subscription_id)
                detailsCache.set(org.subscription_id, details)
              }
            }
            return {
              org_id: org.org_id,
              org_name: org.org_name,
              management_email: org.management_email,
              canceled_at: org.canceled_at,
              plan_name: org.plan_name,
              billing_type: org.billing_type,
              subscription_or_signup_date: org.subscription_or_signup_date,
              cancellation_reason: formatCancellationReason(details, org.churn_reason),
            }
          }),
        )
        result = {
          organizations,
          total: canceledOrgs.total,
        }
        break
      }

      case 'onboarding_funnel':
        result = await getAdminOnboardingFunnel(c, start_date, end_date)
        break

      case 'email_type_breakdown':
        result = await getAdminEmailTypeBreakdown(c, start_date, end_date)
        break

      case 'customer_country_breakdown':
        result = await getAdminCustomerCountryBreakdown(c, start_date, end_date)
        break

      case 'organization_insights':
        result = await getAdminOrganizationInsights(c, start_date, end_date, {
          limit: limit || 50,
          offset: offset || 0,
          plan_name,
          billing_type,
          paid_only,
          search,
        })
        break

      case 'builder_analytics':
        result = await getAdminBuilderAnalytics(c, start_date, end_date)
        break

      default:
        throw simpleError('invalid_metric_category', 'Invalid metric category', { metric_category })
    }

    return c.json({
      success: true,
      metric_category,
      data: result,
      period: {
        start: start_date,
        end: end_date,
      },
    })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cloudlog({ requestId: c.get('requestId'), message: 'admin_stats_error', error: message })
    throw simpleError('admin_stats_error', 'Error fetching admin statistics', { error: message })
  }
})

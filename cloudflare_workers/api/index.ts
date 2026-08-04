import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types'
import type { Bindings } from '../../supabase/functions/_backend/utils/cloudflare.ts'
import { app as accept_invitation } from '../../supabase/functions/_backend/private/accept_invitation.ts'
import { app as admin_credits } from '../../supabase/functions/_backend/private/admin_credits.ts'
import { app as admin_stats } from '../../supabase/functions/_backend/private/admin_stats.ts'
import { app as channel_device } from '../../supabase/functions/_backend/private/channel_device.ts'
import { app as channel_stats } from '../../supabase/functions/_backend/private/channel_stats.ts'
import { app as config } from '../../supabase/functions/_backend/private/config.ts'
import { app as configBuilder } from '../../supabase/functions/_backend/private/config_builder.ts'
import { app as create_device } from '../../supabase/functions/_backend/private/create_device.ts'
import { app as credits } from '../../supabase/functions/_backend/private/credits.ts'
import { app as deleted_failed_version } from '../../supabase/functions/_backend/private/delete_failed_version.ts'
import { app as devices_priv } from '../../supabase/functions/_backend/private/devices.ts'
import { app as events } from '../../supabase/functions/_backend/private/events.ts'
import { app as groups } from '../../supabase/functions/_backend/private/groups.ts'
import { app as invite_existing_user_to_org } from '../../supabase/functions/_backend/private/invite_existing_user_to_org.ts'
import { app as invite_new_user_to_org } from '../../supabase/functions/_backend/private/invite_new_user_to_org.ts'
import { app as latency } from '../../supabase/functions/_backend/private/latency.ts'
import { app as log_as } from '../../supabase/functions/_backend/private/log_as.ts'
import { app as native_observe_stats } from '../../supabase/functions/_backend/private/native_observe_stats.ts'
import { app as org_notification_stats } from '../../supabase/functions/_backend/private/org_notification_stats.ts'
import { app as plans } from '../../supabase/functions/_backend/private/plans.ts'
import { app as publicStats } from '../../supabase/functions/_backend/private/public_stats.ts'
import { app as replay } from '../../supabase/functions/_backend/private/replay.ts'
import { app as role_bindings } from '../../supabase/functions/_backend/private/role_bindings.ts'
import { app as set_manifest } from '../../supabase/functions/_backend/private/set_manifest.ts'
import { app as set_org_email } from '../../supabase/functions/_backend/private/set_org_email.ts'
import { app as sso_check_domain } from '../../supabase/functions/_backend/private/sso/check-domain.ts'
import { app as sso_check_enforcement } from '../../supabase/functions/_backend/private/sso/check-enforcement.ts'
import { app as sso_prelink_internal } from '../../supabase/functions/_backend/private/sso/prelink-internal.ts'
import { app as sso_prelink } from '../../supabase/functions/_backend/private/sso/prelink.ts'
import { app as sso_providers } from '../../supabase/functions/_backend/private/sso/providers.ts'
import { app as sso_provision_user } from '../../supabase/functions/_backend/private/sso/provision-user.ts'
import { app as sso_sp_metadata } from '../../supabase/functions/_backend/private/sso/sp-metadata.ts'
import { app as sso_verify_dns } from '../../supabase/functions/_backend/private/sso/verify-dns.ts'
import { app as stats_priv } from '../../supabase/functions/_backend/private/stats.ts'
import { app as storeTop } from '../../supabase/functions/_backend/private/store_top.ts'
import { app as stripe_checkout } from '../../supabase/functions/_backend/private/stripe_checkout.ts'
import { app as stripe_portal } from '../../supabase/functions/_backend/private/stripe_portal.ts'
import { app as update_delivery_stats } from '../../supabase/functions/_backend/private/update_delivery_stats.ts'
import { app as validate_password_compliance } from '../../supabase/functions/_backend/private/validate_password_compliance.ts'
import { app as verify_email_otp } from '../../supabase/functions/_backend/private/verify_email_otp.ts'
import { app as website_preview } from '../../supabase/functions/_backend/private/website_preview.ts'
import { app as apikey } from '../../supabase/functions/_backend/public/apikey/index.ts'
import { app as appEndpoint } from '../../supabase/functions/_backend/public/app/index.ts'
import { app as build } from '../../supabase/functions/_backend/public/build/index.ts'
import { app as bundle } from '../../supabase/functions/_backend/public/bundle/index.ts'
import { app as channel } from '../../supabase/functions/_backend/public/channel/index.ts'
import { app as check_cpu_usage } from '../../supabase/functions/_backend/public/check_cpu_usage.ts'
import { app as device } from '../../supabase/functions/_backend/public/device/index.ts'
import { app as notifications } from '../../supabase/functions/_backend/public/notifications/index.ts'
import { app as ok } from '../../supabase/functions/_backend/public/ok.ts'
import { app as organization } from '../../supabase/functions/_backend/public/organization/index.ts'
import { app as pluginRegions } from '../../supabase/functions/_backend/public/plugin_regions.ts'
import { app as queue_health } from '../../supabase/functions/_backend/public/queue_health.ts'
import { app as replication } from '../../supabase/functions/_backend/public/replication.ts'
import { app as statistics } from '../../supabase/functions/_backend/public/statistics/index.ts'
import { app as translation } from '../../supabase/functions/_backend/public/translation.ts'
import { app as webhooks } from '../../supabase/functions/_backend/public/webhooks/index.ts'
import { app as credit_usage_alerts } from '../../supabase/functions/_backend/triggers/credit_usage_alerts.ts'
import { app as cron_clean_orphan_images } from '../../supabase/functions/_backend/triggers/cron_clean_orphan_images.ts'
import { app as cron_clear_versions } from '../../supabase/functions/_backend/triggers/cron_clear_versions.ts'
import { app as cron_email } from '../../supabase/functions/_backend/triggers/cron_email.ts'
import { app as cron_reconcile_build_status } from '../../supabase/functions/_backend/triggers/cron_reconcile_build_status.ts'
import { app as cron_rollout_auto_pause } from '../../supabase/functions/_backend/triggers/cron_rollout_auto_pause.ts'
import { app as cron_stat_app } from '../../supabase/functions/_backend/triggers/cron_stat_app.ts'
import { app as cron_stat_org } from '../../supabase/functions/_backend/triggers/cron_stat_org.ts'
import { app as cron_sync_sub } from '../../supabase/functions/_backend/triggers/cron_sync_sub.ts'
import { app as logsnag_insights, logsnagInsightsLegacyUsageApp, logsnagInsightsShardApps } from '../../supabase/functions/_backend/triggers/logsnag_insights.ts'
import { app as on_app_create } from '../../supabase/functions/_backend/triggers/on_app_create.ts'
import { app as on_app_delete } from '../../supabase/functions/_backend/triggers/on_app_delete.ts'
import { app as on_app_update } from '../../supabase/functions/_backend/triggers/on_app_update.ts'
import { app as on_channel_update } from '../../supabase/functions/_backend/triggers/on_channel_update.ts'
import { app as on_deploy_history_create } from '../../supabase/functions/_backend/triggers/on_deploy_history_create.ts'
import { app as on_manifest_create } from '../../supabase/functions/_backend/triggers/on_manifest_create.ts'
import { app as on_org_update } from '../../supabase/functions/_backend/triggers/on_org_update.ts'
import { app as on_organization_create } from '../../supabase/functions/_backend/triggers/on_organization_create.ts'
import { app as on_organization_delete } from '../../supabase/functions/_backend/triggers/on_organization_delete.ts'
import { app as on_user_create } from '../../supabase/functions/_backend/triggers/on_user_create.ts'
import { app as on_user_delete } from '../../supabase/functions/_backend/triggers/on_user_delete.ts'
import { app as on_user_org_access } from '../../supabase/functions/_backend/triggers/on_user_org_access.ts'
import { app as on_user_update } from '../../supabase/functions/_backend/triggers/on_user_update.ts'
import { app as on_version_create } from '../../supabase/functions/_backend/triggers/on_version_create.ts'
import { app as on_version_delete } from '../../supabase/functions/_backend/triggers/on_version_delete.ts'
import { app as on_version_update } from '../../supabase/functions/_backend/triggers/on_version_update.ts'
import { app as pluginNotifications } from '../../supabase/functions/_backend/triggers/plugin_notifications.ts'
import { app as queue_consumer } from '../../supabase/functions/_backend/triggers/queue_consumer.ts'
import { app as stripe_event } from '../../supabase/functions/_backend/triggers/stripe_event.ts'
import { app as webhook_delivery } from '../../supabase/functions/_backend/triggers/webhook_delivery.ts'
import { app as webhook_dispatcher } from '../../supabase/functions/_backend/triggers/webhook_dispatcher.ts'
import { BRES, createAllCatch, createHono } from '../../supabase/functions/_backend/utils/hono.ts'
import { processNativeNotificationQueueBatch } from '../../supabase/functions/_backend/utils/nativeNotificationSender.ts'
import { flushQueuedPluginNotifications } from '../../supabase/functions/_backend/utils/plugin_notification_flush.ts'
import { version } from '../../supabase/functions/_backend/utils/version.ts'

// Public API
const functionName = 'api'
const app = createHono(functionName, version)
const functionNameScheduled = 'api-scheduled'
const appScheduled = createHono(functionNameScheduled, version)
app.route('/ok', ok)
app.route('/apikey', apikey)
app.route('/bundle', bundle)
app.route('/channel', channel)
app.route('/device', device)
app.route('/organization', organization)
app.route('/notifications', notifications)
app.route('/statistics', statistics)
app.route('/webhooks', webhooks)
app.route('/app', appEndpoint)
app.route('/build', build)
app.route('/replication', replication)
app.route('/queue_health', queue_health)
app.route('/check_cpu_usage', check_cpu_usage)
app.route('/translation', translation)
app.route('/plugin_regions', pluginRegions)

// Private API
const functionNamePrivate = 'private'
const appPrivate = createHono(functionNamePrivate, version)
appPrivate.route('/plans', plans)
appPrivate.route('/credits', credits)
appPrivate.route('/store_top', storeTop)
appPrivate.route('/website_stats', publicStats)
appPrivate.route('/config', config)
appPrivate.route('/config/builder', configBuilder)
appPrivate.route('/accept_invitation', accept_invitation)
appPrivate.route('/devices', devices_priv)
appPrivate.route('/channel_device', channel_device)
appPrivate.route('/log_as', log_as)
appPrivate.route('/invite_new_user_to_org', invite_new_user_to_org)
appPrivate.route('/invite_existing_user_to_org', invite_existing_user_to_org)
appPrivate.route('/set_org_email', set_org_email)
appPrivate.route('/validate_password_compliance', validate_password_compliance)
appPrivate.route('/admin_credits', admin_credits)
appPrivate.route('/admin_stats', admin_stats)
appPrivate.route('/stats', stats_priv)
appPrivate.route('/channel_stats', channel_stats)
appPrivate.route('/native_observe_stats', native_observe_stats)
appPrivate.route('/org_notification_stats', org_notification_stats)
appPrivate.route('/update_delivery_stats', update_delivery_stats)
appPrivate.route('/stripe_checkout', stripe_checkout)
appPrivate.route('/stripe_portal', stripe_portal)
appPrivate.route('/verify_email_otp', verify_email_otp)
appPrivate.route('/delete_failed_version', deleted_failed_version)
appPrivate.route('/set_manifest', set_manifest)
appPrivate.route('/create_device', create_device)
appPrivate.route('/latency', latency)
appPrivate.route('/replay', replay)
appPrivate.route('/events', events)
appPrivate.route('/groups', groups)
appPrivate.route('/role_bindings', role_bindings)
appPrivate.route('/website_preview', website_preview)
appPrivate.route('/sso/check-domain', sso_check_domain)
appPrivate.route('/sso/check-enforcement', sso_check_enforcement)
appPrivate.route('/sso/providers', sso_providers)
appPrivate.route('/sso/prelink-users', sso_prelink)
appPrivate.route('/sso/prelink-internal', sso_prelink_internal)
appPrivate.route('/sso/provision-user', sso_provision_user)
appPrivate.route('/sso/sp-metadata', sso_sp_metadata)
appPrivate.route('/sso/verify-dns', sso_verify_dns)

// Triggers
const functionNameTriggers = 'triggers'
const appTriggers = createHono(functionNameTriggers, version)
appTriggers.route('/ok', ok)
appTriggers.route('/cron_email', cron_email)
appTriggers.route('/cron_clear_versions', cron_clear_versions)
appTriggers.route('/cron_clean_orphan_images', cron_clean_orphan_images)
appTriggers.route('/cron_reconcile_build_status', cron_reconcile_build_status)
appTriggers.route('/credit_usage_alerts', credit_usage_alerts)
appTriggers.route('/logsnag_insights', logsnag_insights)
appTriggers.route('/logsnag_insights_core', logsnagInsightsShardApps.core)
appTriggers.route('/logsnag_insights_usage', logsnagInsightsLegacyUsageApp)
appTriggers.route('/logsnag_insights_usage_updates', logsnagInsightsShardApps.usage_updates)
appTriggers.route('/logsnag_insights_usage_devices', logsnagInsightsShardApps.usage_devices)
appTriggers.route('/logsnag_insights_usage_device_platforms', logsnagInsightsShardApps.usage_device_platforms)
appTriggers.route('/logsnag_insights_usage_registrations', logsnagInsightsShardApps.usage_registrations)
appTriggers.route('/logsnag_insights_usage_storage', logsnagInsightsShardApps.usage_storage)
appTriggers.route('/logsnag_insights_usage_success_rate', logsnagInsightsShardApps.usage_success_rate)
appTriggers.route('/logsnag_insights_usage_demo_apps', logsnagInsightsShardApps.usage_demo_apps)
appTriggers.route('/logsnag_insights_revenue', logsnagInsightsShardApps.revenue)
appTriggers.route('/logsnag_insights_plugins', logsnagInsightsShardApps.plugins)
appTriggers.route('/logsnag_insights_builds', logsnagInsightsShardApps.builds)
appTriggers.route('/logsnag_insights_retention', logsnagInsightsShardApps.retention)
appTriggers.route('/logsnag_insights_paid_products', logsnagInsightsShardApps.paid_products)
appTriggers.route('/logsnag_insights_ltv', logsnagInsightsShardApps.ltv)
appTriggers.route('/logsnag_insights_notifications', logsnagInsightsShardApps.notifications)
appTriggers.route('/on_channel_update', on_channel_update)
appTriggers.route('/on_app_create', on_app_create)
appTriggers.route('/on_app_delete', on_app_delete)
appTriggers.route('/on_app_update', on_app_update)
appTriggers.route('/on_org_update', on_org_update)
appTriggers.route('/plugin_notifications', pluginNotifications)
appTriggers.route('/on_organization_delete', on_organization_delete)
appTriggers.route('/on_user_create', on_user_create)
appTriggers.route('/on_user_update', on_user_update)
appTriggers.route('/on_user_delete', on_user_delete)
appTriggers.route('/on_user_org_access', on_user_org_access)
appTriggers.route('/on_version_create', on_version_create)
appTriggers.route('/on_version_update', on_version_update)
appTriggers.route('/on_version_delete', on_version_delete)
appTriggers.route('/on_manifest_create', on_manifest_create)
appTriggers.route('/on_deploy_history_create', on_deploy_history_create)
appTriggers.route('/stripe_event', stripe_event)
appTriggers.route('/on_organization_create', on_organization_create)
appTriggers.route('/cron_stat_app', cron_stat_app)
appTriggers.route('/cron_stat_org', cron_stat_org)
appTriggers.route('/cron_sync_sub', cron_sync_sub)
appTriggers.route('/cron_rollout_auto_pause', cron_rollout_auto_pause)
appTriggers.route('/queue_consumer', queue_consumer)
appTriggers.route('/webhook_delivery', webhook_delivery)
appTriggers.route('/webhook_dispatcher', webhook_dispatcher)

app.route('/triggers', appTriggers)
app.route('/private', appPrivate)

appScheduled.post('/flush-plugin-notifications', async (c) => {
  c.set('deliverPluginNotificationsInProcess', true)
  const result = await flushQueuedPluginNotifications(c)
  return c.json({ ...BRES, ...result })
})

async function runScheduledPluginNotificationFlush(env: Bindings, ctx: ExecutionContext) {
  const request = new Request('https://api-scheduled.capgo.internal/flush-plugin-notifications', { method: 'POST' })
  const response = await appScheduled.fetch(request, env, ctx)
  if (!response.ok)
    throw new Error(`flush-plugin-notifications HTTP ${response.status} ${response.statusText}`)

  const body = await response.json().catch(() => null) as { failed?: unknown } | null
  if (body && typeof body.failed === 'number' && body.failed > 0)
    throw new Error(`flush-plugin-notifications had ${body.failed} failed transfers`)
}

createAllCatch(app, functionName)
createAllCatch(appPrivate, functionNamePrivate)
createAllCatch(appTriggers, functionNameTriggers)
createAllCatch(appScheduled, functionNameScheduled)

export default {
  fetch: app.fetch,
  queue: processNativeNotificationQueueBatch,
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledPluginNotificationFlush(env, ctx))
  },
}

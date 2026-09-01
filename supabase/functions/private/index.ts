import { app as accept_invitation } from '../_backend/private/accept_invitation.ts'
import { app as admin_credits } from '../_backend/private/admin_credits.ts'
import { app as admin_stats } from '../_backend/private/admin_stats.ts'
import { app as channel_device } from '../_backend/private/channel_device.ts'
import { app as bundle_install_stats } from '../_backend/private/bundle_install_stats.ts'
import { app as channel_stats } from '../_backend/private/channel_stats.ts'
import { app as config } from '../_backend/private/config.ts'
import { app as configBuilder } from '../_backend/private/config_builder.ts'
import { app as create_device } from '../_backend/private/create_device.ts'
import { app as credits } from '../_backend/private/credits.ts'
import { app as deleted_failed_version } from '../_backend/private/delete_failed_version.ts'
import { app as devices_priv } from '../_backend/private/devices.ts'
import { app as download_link } from '../_backend/private/download_link.ts'
import { app as emailPreferences } from '../_backend/private/email_preferences.ts'
import { app as events } from '../_backend/private/events.ts'
import { app as groups } from '../_backend/private/groups.ts'
import { app as invite_existing_user_to_org } from '../_backend/private/invite_existing_user_to_org.ts'
import { app as invite_new_user_to_org } from '../_backend/private/invite_new_user_to_org.ts'
import { app as latency } from '../_backend/private/latency.ts'
import { app as log_as } from '../_backend/private/log_as.ts'
import { app as native_observe_stats } from '../_backend/private/native_observe_stats.ts'
import { app as observe } from '../_backend/private/observe.ts'
import { app as org_notification_stats } from '../_backend/private/org_notification_stats.ts'
// Webapps API
import { app as plans } from '../_backend/private/plans.ts'
import { app as publicStats } from '../_backend/private/public_stats.ts'
import { app as replay } from '../_backend/private/replay.ts'
import { app as role_bindings } from '../_backend/private/role_bindings.ts'
import { app as roles } from '../_backend/private/roles.ts'
import { app as set_manifest } from '../_backend/private/set_manifest.ts'
import { app as set_org_email } from '../_backend/private/set_org_email.ts'
import { app as sso_check_domain } from '../_backend/private/sso/check-domain.ts'
import { app as sso_check_enforcement } from '../_backend/private/sso/check-enforcement.ts'
import { app as sso_prelink_internal } from '../_backend/private/sso/prelink-internal.ts'
import { app as sso_prelink } from '../_backend/private/sso/prelink.ts'
import { app as sso_providers } from '../_backend/private/sso/providers.ts'
import { app as sso_provision_user } from '../_backend/private/sso/provision-user.ts'
import { app as sso_sp_metadata } from '../_backend/private/sso/sp-metadata.ts'
import { app as sso_verify_dns } from '../_backend/private/sso/verify-dns.ts'
import { app as stats_priv } from '../_backend/private/stats.ts'
import { app as storeTop } from '../_backend/private/store_top.ts'
import { app as stripe_checkout } from '../_backend/private/stripe_checkout.ts'
import { app as stripe_portal } from '../_backend/private/stripe_portal.ts'
import { app as upload_link } from '../_backend/private/upload_link.ts'
import { app as validate_password_compliance } from '../_backend/private/validate_password_compliance.ts'
import { app as verify_email_otp } from '../_backend/private/verify_email_otp.ts'
import { app as website_preview } from '../_backend/private/website_preview.ts'
import { createAllCatch, createHono } from '../_backend/utils/hono.ts'
import { version } from '../_backend/utils/version.ts'

const functionName = 'private'
const appGlobal = createHono(functionName, version)

// Webapps API

appGlobal.route('/plans', plans)
appGlobal.route('/credits', credits)
appGlobal.route('/store_top', storeTop)
appGlobal.route('/website_stats', publicStats)
appGlobal.route('/config', config)
appGlobal.route('/config/builder', configBuilder)
appGlobal.route('/devices', devices_priv)
appGlobal.route('/channel_device', channel_device)
appGlobal.route('/create_device', create_device)
appGlobal.route('/channel_stats', channel_stats)
appGlobal.route('/bundle_install_stats', bundle_install_stats)
appGlobal.route('/native_observe_stats', native_observe_stats)
appGlobal.route('/observe', observe)
appGlobal.route('/org_notification_stats', org_notification_stats)
appGlobal.route('/download_link', download_link)
appGlobal.route('/log_as', log_as)
appGlobal.route('/admin_credits', admin_credits)
appGlobal.route('/admin_stats', admin_stats)
appGlobal.route('/stats', stats_priv)
appGlobal.route('/stripe_checkout', stripe_checkout)
appGlobal.route('/stripe_portal', stripe_portal)
appGlobal.route('/upload_link', upload_link)
appGlobal.route('/set_manifest', set_manifest)
appGlobal.route('/delete_failed_version', deleted_failed_version)
appGlobal.route('/set_org_email', set_org_email)
appGlobal.route('/latency', latency)
appGlobal.route('/replay', replay)
appGlobal.route('/events', events)
appGlobal.route('/groups', groups)
appGlobal.route('/role_bindings', role_bindings)
appGlobal.route('/roles', roles)
appGlobal.route('/invite_new_user_to_org', invite_new_user_to_org)
appGlobal.route('/invite_existing_user_to_org', invite_existing_user_to_org)
appGlobal.route('/accept_invitation', accept_invitation)
appGlobal.route('/email_preferences', emailPreferences)
appGlobal.route('/validate_password_compliance', validate_password_compliance)
appGlobal.route('/verify_email_otp', verify_email_otp)
appGlobal.route('/website_preview', website_preview)
appGlobal.route('/sso/check-domain', sso_check_domain)
appGlobal.route('/sso/check-enforcement', sso_check_enforcement)
appGlobal.route('/sso/providers', sso_providers)
appGlobal.route('/sso/prelink-users', sso_prelink)
appGlobal.route('/sso/prelink-internal', sso_prelink_internal)
appGlobal.route('/sso/provision-user', sso_provision_user)
appGlobal.route('/sso/sp-metadata', sso_sp_metadata)
appGlobal.route('/sso/verify-dns', sso_verify_dns)

createAllCatch(appGlobal, functionName)
Deno.serve(appGlobal.fetch)

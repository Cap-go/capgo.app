import { z } from 'zod'
import { skillContentSchema, skillSchema } from './skills.ts'

const text = (description: string) => z.string().describe(description)
const number = (description: string) => z.number().describe(description)
const metadata = z
  .record(z.string(), z.unknown())
  .describe(
    'Additional fields whose keys depend on the event or configured provider.',
  )
const timestamp = text('ISO timestamp.').nullable()
const status = text('Operation acknowledgement from the API.')
const ack = z.object({ status }).passthrough()
const app = z
  .object({
    app_id: text('Capacitor app identifier; use as appId in subsequent tools.'),
    name: text('App display name.').nullable().optional(),
    owner_org: text('Owning organization id.').optional(),
    icon_url: text('App icon URL.').nullable().optional(),
    created_at: timestamp.optional(),
    updated_at: timestamp.optional(),
    retention: number('Bundle retention period in seconds.').optional(),
    need_onboarding: z.boolean().optional(),
    device_data_collection: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough()
const account = z
  .object({
    id: text('Authenticated user id.'),
    email: text('Account email.').nullable(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    discord_username: z.string().nullable().optional(),
    format_locale: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    enable_notifications: z.boolean().nullable().optional(),
    opt_for_newsletters: z.boolean().nullable().optional(),
    email_preferences: z.record(z.string(), z.boolean()).nullable().optional(),
    created_at: timestamp.optional(),
  })
  .passthrough()
const organization = z
  .object({
    id: text('Organization id; use as orgId in subsequent tools.'),
    name: text('Organization display name.'),
    management_email: z.string().optional(),
    website: z.string().nullable().optional(),
    logo: z.string().nullable().optional(),
    created_by: z.string().optional(),
    created_at: timestamp.optional(),
    updated_at: timestamp.optional(),
    enforcing_2fa: z.boolean().optional(),
    require_apikey_expiration: z.boolean().optional(),
    max_apikey_expiration_days: z.number().nullable().optional(),
    enforce_hashed_api_keys: z.boolean().optional(),
    password_policy_config: z
      .object({
        enabled: z.boolean().optional(),
        min_length: z.number().optional(),
        require_uppercase: z.boolean().optional(),
        require_number: z.boolean().optional(),
        require_special: z.boolean().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough()
const bundle = z
  .object({
    id: number('Bundle row id.'),
    name: text('Bundle version name.'),
    app_id: text('Owning app identifier.'),
    checksum: z.string().nullable().optional(),
    storage_provider: z.string().nullable().optional(),
    external_url: z.string().nullable().optional(),
    comment: z.string().nullable().optional(),
    link: z.string().nullable().optional(),
    deleted: z.boolean().optional(),
    min_update_version: z.string().nullable().optional(),
    session_key: z.string().nullable().optional(),
    created_at: timestamp.optional(),
    updated_at: timestamp.optional(),
  })
  .passthrough()
const channel = z
  .object({
    id: number('Channel id.'),
    name: text('Channel name.'),
    app_id: text('Owning app identifier.'),
    public: z.boolean().optional(),
    ios: z.boolean().optional(),
    android: z.boolean().optional(),
    version: z
      .union([
        z.number(),
        z.object({ id: z.number(), name: z.string() }).passthrough(),
      ])
      .nullable()
      .optional(),
    disableAutoUpdate: z.string().optional(),
    disableAutoUpdateUnderNative: z.boolean().optional(),
    rolloutEnabled: z.boolean().optional(),
    rolloutPercentageBps: z.number().nullable().optional(),
    rolloutPausedAt: timestamp.optional(),
    pausedAt: timestamp.optional(),
  })
  .passthrough()
const device = z
  .object({
    device_id: text(
      'Device identifier; use for device inspection and channel overrides.',
    ),
    app_id: z.string().optional(),
    platform: z.string().nullable().optional(),
    version_name: z.string().nullable().optional(),
    version_build: z.string().nullable().optional(),
    plugin_version: z.string().nullable().optional(),
    os_version: z.string().nullable().optional(),
    custom_id: z.string().nullable().optional(),
    is_prod: z.boolean().nullable().optional(),
    is_emulator: z.boolean().nullable().optional(),
    created_at: timestamp.optional(),
    updated_at: timestamp.optional(),
  })
  .passthrough()
const webhook = z
  .object({
    id: text('Webhook id.'),
    name: text('Webhook display name.'),
    url: text('Delivery receiver URL.'),
    org_id: z.string().optional(),
    enabled: z.boolean().optional(),
    events: z.array(z.string()).optional(),
    secret: text(
      'Signing secret returned on creation; store securely and do not repeat in chat.',
    ).optional(),
    created_at: timestamp.optional(),
    updated_at: timestamp.optional(),
    stats_24h: z
      .object({ success: z.number(), failed: z.number(), pending: z.number() })
      .optional(),
  })
  .passthrough()
const diagnostic = z
  .object({
    classification: text(
      'normal, policy, error, cancelled or unknown; not proof of root cause.',
    ),
    meaning: text('Documented interpretation of the event or build state.'),
    next_steps: z
      .array(z.string())
      .describe(
        'Checks or remedies to consider, not actions authorized by reading this result.',
      ),
    docs_url: text('Supporting troubleshooting documentation.'),
    evidence: z.string().optional(),
    code: z.string().optional(),
    requires_action: z.boolean().nullable().optional(),
  })
  .passthrough()
const sample = z
  .object({
    device_id: z.string(),
    action: z.string(),
    version_name: z.string(),
    created_at: z.string(),
    duration_ms: z.number().nullable(),
    route: z.string().nullable(),
    metadata: metadata.nullable(),
    diagnostic: diagnostic.optional(),
  })
  .passthrough()
const period = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
    end_exclusive: z.string().optional(),
    days: z.number().optional(),
  })
  .passthrough()
const insightTotal = z
  .object({ action: z.string(), total: z.number() })
  .passthrough()
const scan = z
  .object({
    scanned: z.number().optional(),
    scan_limit: z.number().optional(),
    ordered_by: z.literal('created_at').optional(),
    duration_sort: z.literal('in_memory_over_recent_window').optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough()
const observe = z
  .object({
    app_id: text('App whose telemetry was queried.'),
    view: z.enum([
      'summary',
      'metrics',
      'events',
      'device',
      'versions',
      'routes',
      'release',
      'logs',
      'errors',
    ]),
    period: period.optional(),
    agent_instructions: text(
      'Interpretation and follow-up guidance; missing samples do not prove health.',
    ).optional(),
    samples: z.array(sample).optional(),
    sample_scan: scan.optional(),
    summary: z
      .object({
        total: z.number(),
        device_count: z.number().optional(),
        action_count: z.number().optional(),
      })
      .passthrough()
      .optional(),
    actions: z.array(insightTotal).optional(),
    daily: z
      .array(
        z
          .object({ date: z.string(), action: z.string(), total: z.number() })
          .passthrough(),
      )
      .optional(),
    versions: z
      .array(
        z
          .object({
            version_name: z.string().optional(),
            devices: z.number().optional(),
            issue_count: z.number().optional(),
            issue_free_rate: z.number().nullable().optional(),
            launch_p90_ms: z.number().nullable().optional(),
            total: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
    devices: z
      .array(
        z
          .object({ device_id: z.string(), total: z.number().optional() })
          .passthrough(),
      )
      .optional(),
    overview: z
      .object({
        total_events: z.number().optional(),
        total_devices: z.number().optional(),
        issue_count: z.number().optional(),
        affected_devices: z.number().optional(),
        issue_free_rate: z.number().nullable().optional(),
        launch_timeout_count: z.number().optional(),
        launch_p90_ms: z.number().nullable().optional(),
        webview_load_p90_ms: z.number().nullable().optional(),
      })
      .passthrough()
      .optional(),
    actionBreakdown: z
      .array(
        z
          .object({
            action: z.string(),
            events: z.number(),
            devices: z.number(),
            p50_ms: z.number().nullable(),
            p90_ms: z.number().nullable(),
            p99_ms: z.number().nullable(),
            is_issue: z.boolean(),
          })
          .passthrough(),
      )
      .optional(),
    routes: z
      .array(
        z.object({
          route: z.string(),
          events: z.number(),
          devices: z.number(),
          p50_ms: z.number().nullable(),
          p90_ms: z.number().nullable(),
        }),
      )
      .optional(),
    release: z
      .object({
        channel: z
          .object({ id: z.number().optional(), name: z.string().optional() })
          .passthrough()
          .nullable()
          .optional(),
        recent_deployments: z.array(metadata).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    diagnostics: z
      .array(diagnostic.extend({ action: z.string().optional() }))
      .optional(),
    aggregate_scope: z
      .object({
        app_id: z.string(),
        version_name: z.string().nullable(),
        device_filter_applied: z.boolean(),
        metadata_policy_filter_applied: z.boolean(),
      })
      .optional(),
    aggregate_caveat: z.string().optional(),
    poll_after_seconds: z.number().optional(),
    handoff_prompt: z.string().optional(),
  })
  .passthrough()
const usageDay = z
  .object({
    date: text('Date of this usage bucket.'),
    mau: number('Active devices in the reporting bucket.'),
    storage: number('Stored bytes.'),
    storage_byte_hours: z.number().optional(),
    bandwidth: number('Transferred bytes.'),
    build_time_seconds: number('Native build time in seconds.'),
    get: z.number().optional(),
  })
  .passthrough()
const usage = z.union([
  z.array(usageDay),
  z.object({
    global: z.array(usageDay),
    byApp: z.array(usageDay.extend({ app_id: z.string() })),
  }),
])
const versionUsage = z
  .object({
    labels: z
      .array(z.string())
      .describe('Dates corresponding to the dataset values.'),
    datasets: z.array(
      z
        .object({
          label: z.string(),
          data: z.array(z.number()),
          metaCounts: z.array(z.number()).optional(),
        })
        .passthrough(),
    ),
    latestVersion: z
      .object({
        name: z.string(),
        percentage: z
          .string()
          .describe('Percentage formatted to one decimal place.'),
      })
      .optional(),
  })
  .passthrough()
const signedUpload = z
  .object({
    job_id: text('Cloud build job identifier.'),
    upload_url: text(
      'Short-lived signed URL. Upload locally; never expose the URL or its token publicly.',
    ),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expires_at: text('Signed URL expiration.'),
    max_bytes: number('Maximum upload bytes.'),
  })
  .passthrough()
const buildStatus = z
  .object({
    job_id: text('Cloud job whose status is returned.'),
    status: text('Current builder lifecycle state.'),
    diagnostic: diagnostic.optional(),
    poll_after_seconds: z.number().optional(),
    machine: z
      .object({ name: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    started_at: timestamp.optional(),
    completed_at: timestamp.optional(),
    runner_wait_seconds: z.number().nullable().optional(),
    build_time_seconds: z.number().nullable().optional(),
    error: z.string().nullable().optional(),
    persisted: z.boolean().optional(),
    timeout_exceeded: z.boolean().optional(),
    timeout_warning: z.string().optional(),
    queue_priority: z.number().nullable().optional(),
    effective_queue_priority: z.number().nullable().optional(),
  })
  .passthrough()
const notificationSettings = z.object({
  appId: text('App owning these push settings.'),
  pushUpdateEnabled: z.boolean(),
  pushUpdateInstallMode: z.enum(['next', 'set']),
  pushUpdateChannel: z.string().nullable(),
})
const campaign = z
  .object({
    id: text('Push campaign id.'),
    app_id: z.string().optional(),
    name: z.string().nullable().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    created_at: timestamp.optional(),
  })
  .passthrough()
const notificationSend = z
  .object({
    status,
    campaignId: text('Created campaign id.'),
    queued: z.union([z.boolean(), z.number()]),
    queuedBuckets: z.number(),
    targeted: z.number().nullable(),
  })
  .passthrough()
const subscription = z
  .object({
    id: text('Subscription id.'),
    name: z.string().optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    expires_at: timestamp.optional(),
    verified_at: timestamp.optional(),
    org_id: z.string().optional(),
    mcp_event: z.string().nullable().optional(),
    mcp_arguments: metadata.nullable().optional(),
    mcp_verified_at: timestamp.optional(),
  })
  .passthrough()
const api = (payload: z.ZodType, description: string) =>
  z
    .object({ data: payload.describe(description) })
    .describe(
      'Successful API response. The data property contains the typed endpoint payload; text content remains available for older clients.',
    )

export const MCP_OUTPUT_SCHEMAS = {
  capgo_whoami: z.object({
    user_id: text('Authenticated user id.'),
    apikey_id: number('Connection API key id; not the secret.'),
    apikey_name: z.string(),
    apikey_expires_at: timestamp,
  }),
  capgo_get_account: api(
    account,
    'Current account profile and notification preferences.',
  ),
  capgo_update_account: api(
    account,
    'Updated account profile; omitted settings are preserved.',
  ),
  capgo_list_organizations: api(
    z.array(organization),
    'Accessible organizations on this page. An empty array means no matches.',
  ),
  capgo_get_organization: api(
    organization,
    'Requested organization and its membership policies.',
  ),
  capgo_add_organization: api(
    z.object({ id: text('New organization id.') }),
    'Created organization identifier.',
  ),
  capgo_update_organization: api(
    z.object({ status, id: z.string(), data: organization }),
    'Updated organization settings.',
  ),
  capgo_delete_organization: api(ack, 'Deletion acknowledgement.'),
  capgo_list_organization_members: api(
    z.array(
      z.object({
        uid: text('Member user id.'),
        email: z.string(),
        image_url: z.string().nullable().optional(),
        role: z.string(),
        is_tmp: z.boolean(),
      }),
    ),
    'Organization members and their roles.',
  ),
  capgo_invite_organization_member: api(
    ack,
    'Invitation acknowledgement; does not imply the invitation was accepted.',
  ),
  capgo_update_organization_member_role: api(
    ack,
    'Role-change acknowledgement.',
  ),
  capgo_remove_organization_member: api(
    ack,
    'Membership removal acknowledgement.',
  ),
  capgo_list_audit_logs: api(
    z.object({
      data: z.array(
        z.object({
          id: z.number(),
          created_at: z.string(),
          table_name: z.string(),
          record_id: z.string(),
          operation: z.string(),
          user_id: z.string().nullable(),
          org_id: z.string(),
          old_record: z.unknown(),
          new_record: z.unknown(),
          changed_fields: z.array(z.string()).nullable(),
          actor_type: z.string(),
          actor_user_id: z.string().nullable(),
          actor_user_email: z.string().nullable(),
          actor_apikey_id: z.number().nullable(),
          actor_apikey_name: z.string().nullable(),
        }),
      ),
      total: z.number(),
      page: z.number(),
      limit: z.number(),
    }),
    'Audit records and exact pagination metadata.',
  ),
  capgo_list_api_keys: api(
    z.array(
      z
        .object({
          id: z.number(),
          name: z.string(),
          created_at: timestamp.optional(),
          updated_at: timestamp.optional(),
          expires_at: timestamp,
          user_id: z.string().optional(),
          is_hashed_key: z.boolean().optional(),
          global_permissions: z.array(z.string()).optional(),
        })
        .passthrough(),
    ),
    'Manageable API key metadata; no API key secrets.',
  ),
  capgo_delete_api_key: api(ack, 'API key revocation acknowledgement.'),
  capgo_list_apps: api(z.array(app), 'Accessible apps on this page.'),
  capgo_get_app: api(app, 'Requested app configuration.'),
  capgo_add_app: api(
    app.extend({
      status: z.literal('already_exists').optional(),
      message: z.string().optional(),
      next_steps: z.array(z.string()).optional(),
    }),
    'Newly registered app.',
  ),
  capgo_update_app: api(app, 'Updated app configuration.'),
  capgo_delete_app: api(ack, 'App deletion acknowledgement.'),
  capgo_create_demo_app: api(
    z.object({
      status,
      app_id: z.string(),
      name: z.string(),
      message: z.string(),
    }),
    'Created demo app with sample data.',
  ),
  capgo_fetch_store_metadata: api(
    z.object({
      status,
      name: z.string(),
      icon_url: z.string().nullable(),
      icon_data_url: z.string().nullable(),
      screenshot_url: z.string().nullable(),
      app_id: z.string().nullable(),
      app_id_lookup_failed: z.boolean(),
      android_app_id: z.string().nullable(),
      ios_bundle_id: z.string().nullable(),
      url: z.string(),
    }),
    'Public store metadata; null identifiers may require manual entry.',
  ),
  capgo_get_upload_command: z.object({
    command: text(
      'Ready-to-run local command containing the connection key. Never share or log it.',
    ),
    apikeyExpiresAt: timestamp,
    note: z.string(),
  }),
  capgo_list_bundles: api(
    z.array(bundle),
    'Bundles on this page. Continue with the same filters and the next page if full.',
  ),
  capgo_create_bundle_from_url: api(
    z.object({ status, bundle }),
    'Bundle registered from its external archive URL.',
  ),
  capgo_update_bundle_metadata: api(ack, 'Metadata update acknowledgement.'),
  capgo_set_bundle_channel: api(
    z.object({ status, message: z.string() }),
    'Channel deployment acknowledgement.',
  ),
  capgo_delete_bundle: api(
    ack.extend({ id: z.number().optional(), name: z.string().optional() }),
    'Bundle deletion acknowledgement.',
  ),
  capgo_prepare_bundle_upload: api(
    z.union([
      z.object({
        status,
        skipped: z.literal(true),
        reason: z.literal('VERSION_EXISTS'),
        app_id: z.string(),
        version: z.string(),
      }),
      z
        .object({
          upload_token: text(
            'Pass to complete or abort after uploading; sensitive short-lived token.',
          ),
          expires_at: z.string(),
          app_id: z.string(),
          version: z.string(),
          version_id: z.number(),
          encrypted: z.boolean(),
          checksum_algorithm: z.string(),
          min_update_version: z.string().nullable(),
          delta: z.string(),
          bundle_upload: z.object({
            url: z.string(),
            method: z.literal('PUT'),
            headers: z.record(z.string(), z.string()),
            expires_at: z.string(),
            max_size_bytes: z.number(),
          }),
          delta_pack_upload: z
            .object({
              url: z.string(),
              method: z.literal('PUT'),
              headers: z.record(z.string(), z.string()),
              expires_at: z.string(),
              max_size_bytes: z.number(),
            })
            .optional(),
          channels: z.array(
            z
              .object({
                name: z.string(),
                compatibility: z.enum([
                  'compatible',
                  'incompatible',
                  'skipped',
                ]),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ]),
    'Either a skipped existing version (stop) or signed upload details (PUT then complete).',
  ),
  capgo_complete_bundle_upload: api(
    ack.extend({
      app_id: z.string(),
      version: z.string(),
      version_id: z.number(),
      checksum: z.string().nullable(),
      encrypted: z.boolean(),
      storage_provider: z.string(),
      channels_updated: z.array(z.string()),
      channels_skipped_same_checksum: z.array(z.string()),
      warnings: z.array(z.string()),
      size_bytes: z.number().optional(),
      resumed: z.boolean().optional(),
      delta: metadata.nullable(),
      deleted_linked_bundles: z.array(
        z.union([z.string(), z.number(), metadata]),
      ),
    }),
    'Finalized upload, channel deployments, skipped channels and warnings.',
  ),
  capgo_abort_bundle_upload: api(
    ack.extend({
      app_id: z.string(),
      version: z.string(),
      aborted: z.literal(true),
    }),
    'Unfinished upload removed.',
  ),
  capgo_list_channels: api(z.array(channel), 'Channels on this page.'),
  capgo_get_channel: api(channel, 'Channel settings and current bundle.'),
  capgo_add_channel: api(
    ack.extend(channel.partial().shape),
    'Channel creation acknowledgement and created channel fields when returned.',
  ),
  capgo_update_channel: api(ack, 'Channel update acknowledgement.'),
  capgo_update_channel_rollout: api(ack, 'Rollout update acknowledgement.'),
  capgo_delete_channel: api(ack, 'Channel deletion acknowledgement.'),
  capgo_list_devices: api(
    z.object({
      data: z.array(device),
      nextCursor: z.string().nullable().optional(),
      hasMore: z.boolean(),
    }),
    'Device page. Use nextCursor when hasMore is true.',
  ),
  capgo_get_device: api(device, 'Requested device information.'),
  capgo_set_device_channel: api(
    ack,
    'Forced channel override acknowledgement.',
  ),
  capgo_unset_device_channel: api(
    ack,
    'Channel override removal acknowledgement.',
  ),
  capgo_get_app_statistics: api(
    usage,
    'Daily or cumulative app usage, according to noAccumulate.',
  ),
  capgo_get_organization_statistics: api(
    usage,
    'Daily/cumulative organization usage; breakdown includes global and byApp series.',
  ),
  capgo_get_account_statistics: api(
    usage,
    'Daily/cumulative usage across the account.',
  ),
  capgo_get_bundle_usage: api(versionUsage, 'OTA version usage series.'),
  capgo_get_native_usage: api(versionUsage, 'Native version usage series.'),
  capgo_observe: api(
    observe,
    'View-specific telemetry. Read sample_scan and aggregate_scope before interpreting counts.',
  ),
  capgo_request_build: z.object({
    job_id: text(
      'Use this cloud job id for upload, start, status, logs and cancel tools.',
    ),
    upload: signedUpload,
    next_step: text('Upload the archive before starting the build.'),
  }),
  capgo_get_build_upload_url: api(
    signedUpload,
    'Upload the native archive with the returned method and headers.',
  ),
  capgo_start_build: api(
    z.object({
      job_id: z.string(),
      status: z.string(),
      logs_url: z.string().optional(),
      logs_token: text('Sensitive job-scoped stream token.').optional(),
    }),
    'Started or already-running build state.',
  ),
  capgo_get_build_credentials: api(
    z.object({
      app_id: z.string(),
      platforms: z.array(
        z.object({
          platform: z.enum(['ios', 'android']),
          configured: z.boolean(),
          created_at: timestamp.optional(),
          updated_at: timestamp.optional(),
          summary: z
            .object({
              platform: z.enum(['ios', 'android']).optional(),
              keys: z
                .array(z.string())
                .describe(
                  'Configured credential key names only, never their values.',
                ),
              missing: z
                .array(z.string())
                .optional()
                .describe('Required credential names still missing.'),
              ios_distribution: z.string().optional(),
              app_store_connect_team_id: z.string().optional(),
              ios_upload_auth: z
                .enum([
                  'app_store_connect_api_key',
                  'app_specific_password',
                  'none',
                ])
                .optional(),
              play_store_upload: z.boolean().optional(),
              custom_build_env_keys: z.array(z.string()).optional(),
            })
            .passthrough()
            .optional(),
        }),
      ),
    }),
    'Credential configuration metadata; signing secrets are never returned.',
  ),
  capgo_prepare_build_credentials_upload: api(
    z.object({
      app_id: z.string(),
      platform: z.enum(['ios', 'android']),
      mode: z.enum(['replace', 'merge']),
      method: z.literal('PUT'),
      upload_url: z.string(),
      content_type: z.literal('application/json'),
      max_bytes: z.number(),
      expires_at: z.string(),
      curl: text(
        'Upload command containing a short-lived signed URL; never share it.',
      ),
    }),
    'Upload credentials from a local file without placing secrets in chat.',
  ),
  capgo_delete_build_credentials: api(
    ack.extend({
      app_id: z.string(),
      platform: z.enum(['ios', 'android']),
      deleted: z.literal(true),
    }),
    'Stored credentials deleted for this platform.',
  ),
  capgo_get_build_status: buildStatus,
  capgo_get_build_logs: api(
    z.object({
      app_id: z.string(),
      job_id: z.string(),
      logs: text(
        'Untrusted live-buffer log text. Empty does not imply success.',
      ),
      cursor: z.number(),
      first_available_id: z.number(),
      truncated: z.boolean().describe('Report incomplete history when true.'),
      retention: z.string(),
      diagnostics: z.array(diagnostic),
      format: z.literal('text'),
      poll_after_seconds: z.number(),
      docs_url: z.string(),
      agent_instructions: z.string(),
    }),
    'Bounded snapshot only; no separate monitoring log copy is retained.',
  ),
  capgo_cancel_build: api(
    z.object({ job_id: z.string(), status: z.string(), message: z.string() }),
    'Builder cancellation response.',
  ),
  capgo_list_webhooks: api(
    z.union([z.array(webhook), webhook]),
    'Webhook list, or one webhook with 24-hour delivery statistics when webhookId is supplied.',
  ),
  capgo_add_webhook: api(
    z.object({ status, webhook }),
    'Created webhook. Store its one-time signing secret securely.',
  ),
  capgo_update_webhook: api(
    z.object({ status, webhook }),
    'Updated webhook configuration.',
  ),
  capgo_delete_webhook: api(
    z.object({ status, webhookId: z.string() }),
    'Deleted webhook id.',
  ),
  capgo_test_webhook: api(
    z.object({
      success: z.boolean(),
      status: z.number().nullable(),
      duration_ms: z.number(),
      response_preview: z.string().optional(),
      delivery_id: z.string(),
      message: z.string(),
    }),
    'Delivery attempt result; success=false means the receiver rejected or failed the test.',
  ),
  capgo_list_webhook_deliveries: api(
    z.object({
      deliveries: z.array(
        z
          .object({
            id: z.string(),
            webhook_id: z.string().optional(),
            status: z.string(),
            created_at: timestamp.optional(),
            attempts: z.number().optional(),
            response_status: z.number().nullable().optional(),
          })
          .passthrough(),
      ),
      pagination: z.object({
        page: z.number(),
        per_page: z.number(),
        total: z.number(),
        has_more: z.boolean(),
      }),
    }),
    'Delivery history with pagination.',
  ),
  capgo_retry_webhook_delivery: api(
    z.object({ status, deliveryId: z.string() }),
    'Retry queued; this does not mean the receiver accepted the delivery.',
  ),
  capgo_list_event_types: z.object({
    events: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          delivery: z.array(z.literal('webhook')),
          inputSchema: metadata,
          payloadSchema: metadata,
        })
        .passthrough(),
    ),
  }),
  capgo_subscribe_events: z
    .object({
      id: z.string(),
      refreshBefore: text(
        'ISO timestamp before which the subscription must be renewed.',
      ),
      secret: text(
        'One-time signing secret, returned only when generated.',
      ).optional(),
      verificationFailed: z.boolean().optional(),
      verificationReason: z.string().optional(),
    })
    .passthrough(),
  capgo_list_event_subscriptions: z.object({
    items: z
      .array(subscription)
      .describe(
        'MCP event subscriptions, including inactive records; secrets excluded.',
      ),
  }),
  capgo_unsubscribe_events: z.object({
    id: z.string(),
    unsubscribed: z.literal(true),
  }),
  capgo_get_notification_settings: api(
    notificationSettings,
    'Current app push settings.',
  ),
  capgo_update_notification_settings: api(
    notificationSettings,
    'Updated app push settings.',
  ),
  capgo_list_notification_providers: api(
    z.object({
      data: z.array(
        z
          .object({
            id: z.string(),
            provider: z.string().optional(),
            enabled: z.boolean().optional(),
            config: metadata.optional(),
          })
          .passthrough(),
      ),
    }),
    'Provider metadata; secret configuration is redacted.',
  ),
  capgo_send_notification: api(
    notificationSend,
    'Queued push campaign; queue acceptance is not device delivery confirmation.',
  ),
  capgo_trigger_update_check: api(
    notificationSend,
    'Queued silent update-check campaign.',
  ),
  capgo_list_notification_campaigns: api(
    z.object({ data: z.array(campaign) }),
    'Last 100 notification campaigns.',
  ),
  capgo_get_notification_stats: api(
    z.object({
      data: z.array(z.object({ event: z.string(), count: z.number() })),
    }),
    'Aggregated notification events for the requested time range.',
  ),
  capgo_list_skills: z.object({ skills: z.array(skillSchema) }),
  capgo_get_skill: z.object({
    skill: skillSchema,
    contents: z.array(skillContentSchema),
  }),
  capgo_search_docs: z.object({
    results: z.array(
      z.object({
        title: text('Matching page title.'),
        url: text(
          'Fetch this public documentation page for full instructions.',
        ),
        snippet: z.string().optional(),
      }),
    ),
    message: z.string().optional(),
  }),
} satisfies Record<string, z.ZodObject>

export type McpToolName = keyof typeof MCP_OUTPUT_SCHEMAS

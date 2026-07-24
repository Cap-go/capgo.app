export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      apikey_global_permissions: {
        Row: {
          apikey_rbac_id: string
          created_at: string
          granted_by: string | null
          id: number
          permission_key: string
          reason: string | null
        }
        Insert: {
          apikey_rbac_id: string
          created_at?: string
          granted_by?: string | null
          id?: number
          permission_key: string
          reason?: string | null
        }
        Update: {
          apikey_rbac_id?: string
          created_at?: string
          granted_by?: string | null
          id?: number
          permission_key?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "apikey_global_permissions_apikey_rbac_id_fkey"
            columns: ["apikey_rbac_id"]
            isOneToOne: false
            referencedRelation: "apikeys"
            referencedColumns: ["rbac_id"]
          },
          {
            foreignKeyName: "apikey_global_permissions_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      apikeys: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: number
          key: string | null
          key_hash: string | null
          name: string
          rbac_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: number
          key?: string | null
          key_hash?: string | null
          name: string
          rbac_id?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: number
          key?: string | null
          key_hash?: string | null
          name?: string
          rbac_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "apikeys_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      app_metrics_cache: {
        Row: {
          cached_at: string
          end_date: string
          id: number
          org_id: string
          response: Json
          start_date: string
        }
        Insert: {
          cached_at?: string
          end_date: string
          id?: number
          org_id: string
          response: Json
          start_date: string
        }
        Update: {
          cached_at?: string
          end_date?: string
          id?: number
          org_id?: string
          response?: Json
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_metrics_cache_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      app_versions: {
        Row: {
          app_id: string
          checksum: string | null
          cli_version: string | null
          comment: string | null
          created_at: string | null
          created_by_apikey_rbac_id: string | null
          deleted: boolean
          deleted_at: string | null
          external_url: string | null
          id: number
          key_id: string | null
          link: string | null
          manifest:
            | Database["public"]["CompositeTypes"]["manifest_entry"][]
            | null
          manifest_count: number
          min_update_version: string | null
          name: string
          native_packages: Json[] | null
          owner_org: string
          r2_path: string | null
          session_key: string | null
          storage_provider: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          app_id: string
          checksum?: string | null
          cli_version?: string | null
          comment?: string | null
          created_at?: string | null
          created_by_apikey_rbac_id?: string | null
          deleted?: boolean
          deleted_at?: string | null
          external_url?: string | null
          id?: number
          key_id?: string | null
          link?: string | null
          manifest?:
            | Database["public"]["CompositeTypes"]["manifest_entry"][]
            | null
          manifest_count?: number
          min_update_version?: string | null
          name: string
          native_packages?: Json[] | null
          owner_org: string
          r2_path?: string | null
          session_key?: string | null
          storage_provider?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          app_id?: string
          checksum?: string | null
          cli_version?: string | null
          comment?: string | null
          created_at?: string | null
          created_by_apikey_rbac_id?: string | null
          deleted?: boolean
          deleted_at?: string | null
          external_url?: string | null
          id?: number
          key_id?: string | null
          link?: string | null
          manifest?:
            | Database["public"]["CompositeTypes"]["manifest_entry"][]
            | null
          manifest_count?: number
          min_update_version?: string | null
          name?: string
          native_packages?: Json[] | null
          owner_org?: string
          r2_path?: string | null
          session_key?: string | null
          storage_provider?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_versions_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "owner_org_id_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      app_versions_meta: {
        Row: {
          app_id: string
          checksum: string
          created_at: string | null
          id: number
          owner_org: string
          size: number
          updated_at: string | null
        }
        Insert: {
          app_id: string
          checksum: string
          created_at?: string | null
          id?: number
          owner_org: string
          size: number
          updated_at?: string | null
        }
        Update: {
          app_id?: string
          checksum?: string
          created_at?: string | null
          id?: number
          owner_org?: string
          size?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_versions_meta_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "app_versions_meta_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_org_id_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      apps: {
        Row: {
          allow_device_custom_id: boolean
          allow_preview: boolean
          android_store_url: string | null
          app_id: string
          block_provider_infra_requests: boolean
          build_timeout_seconds: number
          build_timeout_updated_at: string
          channel_device_count: number
          created_at: string | null
          created_from_onboarding: boolean
          default_upload_channel: string
          existing_app: boolean
          expose_metadata: boolean
          icon_url: string
          id: string | null
          ios_store_url: string | null
          last_version: string | null
          manifest_bundle_count: number
          name: string | null
          need_onboarding: boolean
          onboarding_completed_at: string | null
          owner_org: string
          retention: number
          rollout_channel_count: number
          rollout_paused_version_names: string[]
          stats_refresh_requested_at: string | null
          stats_updated_at: string | null
          transfer_history: Json[] | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          allow_device_custom_id?: boolean
          allow_preview?: boolean
          android_store_url?: string | null
          app_id: string
          block_provider_infra_requests?: boolean
          build_timeout_seconds?: number
          build_timeout_updated_at?: string
          channel_device_count?: number
          created_at?: string | null
          created_from_onboarding?: boolean
          default_upload_channel?: string
          existing_app?: boolean
          expose_metadata?: boolean
          icon_url: string
          id?: string | null
          ios_store_url?: string | null
          last_version?: string | null
          manifest_bundle_count?: number
          name?: string | null
          need_onboarding?: boolean
          onboarding_completed_at?: string | null
          owner_org: string
          retention?: number
          rollout_channel_count?: number
          rollout_paused_version_names?: string[]
          stats_refresh_requested_at?: string | null
          stats_updated_at?: string | null
          transfer_history?: Json[] | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          allow_device_custom_id?: boolean
          allow_preview?: boolean
          android_store_url?: string | null
          app_id?: string
          block_provider_infra_requests?: boolean
          build_timeout_seconds?: number
          build_timeout_updated_at?: string
          channel_device_count?: number
          created_at?: string | null
          created_from_onboarding?: boolean
          default_upload_channel?: string
          existing_app?: boolean
          expose_metadata?: boolean
          icon_url?: string
          id?: string | null
          ios_store_url?: string | null
          last_version?: string | null
          manifest_bundle_count?: number
          name?: string | null
          need_onboarding?: boolean
          onboarding_completed_at?: string | null
          owner_org?: string
          retention?: number
          rollout_channel_count?: number
          rollout_paused_version_names?: string[]
          stats_refresh_requested_at?: string | null
          stats_updated_at?: string | null
          transfer_history?: Json[] | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "apps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_org_id_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          actor_apikey_id: number | null
          actor_apikey_name: string | null
          actor_type: string
          actor_user_email: string | null
          actor_user_id: string | null
          changed_fields: string[] | null
          created_at: string
          id: number
          new_record: Json | null
          old_record: Json | null
          operation: string
          org_id: string
          record_id: string
          table_name: string
          user_id: string | null
        }
        Insert: {
          actor_apikey_id?: number | null
          actor_apikey_name?: string | null
          actor_type?: string
          actor_user_email?: string | null
          actor_user_id?: string | null
          changed_fields?: string[] | null
          created_at?: string
          id?: number
          new_record?: Json | null
          old_record?: Json | null
          operation: string
          org_id: string
          record_id: string
          table_name: string
          user_id?: string | null
        }
        Update: {
          actor_apikey_id?: number | null
          actor_apikey_name?: string | null
          actor_type?: string
          actor_user_email?: string | null
          actor_user_id?: string | null
          changed_fields?: string[] | null
          created_at?: string
          id?: number
          new_record?: Json | null
          old_record?: Json | null
          operation?: string
          org_id?: string
          record_id?: string
          table_name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      backfill_progress: {
        Row: {
          created_at: string
          cutover_at: string
          job_name: string
          last_processed_id: number | null
          last_processed_occurred_at: string | null
          scope_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cutover_at: string
          job_name: string
          last_processed_id?: number | null
          last_processed_occurred_at?: string | null
          scope_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cutover_at?: string
          job_name?: string
          last_processed_id?: number | null
          last_processed_occurred_at?: string | null
          scope_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      bandwidth_usage: {
        Row: {
          app_id: string
          device_id: string
          file_size: number
          id: number
          timestamp: string
        }
        Insert: {
          app_id: string
          device_id: string
          file_size: number
          id?: number
          timestamp?: string
        }
        Update: {
          app_id?: string
          device_id?: string
          file_size?: number
          id?: number
          timestamp?: string
        }
        Relationships: []
      }
      build_logs: {
        Row: {
          app_id: string | null
          billable_seconds: number
          build_id: string
          build_time_unit: number
          created_at: string
          id: string
          org_id: string
          platform: string
          user_id: string | null
        }
        Insert: {
          app_id?: string | null
          billable_seconds: number
          build_id: string
          build_time_unit: number
          created_at?: string
          id?: string
          org_id: string
          platform: string
          user_id?: string | null
        }
        Update: {
          app_id?: string | null
          billable_seconds?: number
          build_id?: string
          build_time_unit?: number
          created_at?: string
          id?: string
          org_id?: string
          platform?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "build_logs_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "build_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      build_requests: {
        Row: {
          ai_analyzed: boolean
          app_id: string
          build_config: Json | null
          build_mode: string
          builder_job_id: string | null
          created_at: string
          id: string
          last_error: string | null
          owner_org: string
          platform: string
          requested_by: string
          runner_wait_seconds: number
          status: string
          updated_at: string
          upload_expires_at: string
          upload_path: string
          upload_session_key: string
          upload_url: string
        }
        Insert: {
          ai_analyzed?: boolean
          app_id: string
          build_config?: Json | null
          build_mode?: string
          builder_job_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          owner_org: string
          platform: string
          requested_by: string
          runner_wait_seconds?: number
          status?: string
          updated_at?: string
          upload_expires_at: string
          upload_path: string
          upload_session_key: string
          upload_url: string
        }
        Update: {
          ai_analyzed?: boolean
          app_id?: string
          build_config?: Json | null
          build_mode?: string
          builder_job_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          owner_org?: string
          platform?: string
          requested_by?: string
          runner_wait_seconds?: number
          status?: string
          updated_at?: string
          upload_expires_at?: string
          upload_path?: string
          upload_session_key?: string
          upload_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "build_requests_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "build_requests_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      capgo_credits_steps: {
        Row: {
          created_at: string
          id: number
          org_id: string | null
          price_per_unit: number
          step_max: number
          step_min: number
          type: string
          unit_factor: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: number
          org_id?: string | null
          price_per_unit: number
          step_max: number
          step_min: number
          type: string
          unit_factor?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: number
          org_id?: string | null
          price_per_unit?: number
          step_max?: number
          step_min?: number
          type?: string
          unit_factor?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "capgo_credits_steps_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_devices: {
        Row: {
          app_id: string
          channel_id: number
          created_at: string | null
          device_id: string
          id: number
          owner_org: string
          updated_at: string
        }
        Insert: {
          app_id: string
          channel_id: number
          created_at?: string | null
          device_id: string
          id?: number
          owner_org: string
          updated_at?: string
        }
        Update: {
          app_id?: string
          channel_id?: number
          created_at?: string | null
          device_id?: string
          id?: number
          owner_org?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_devices_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "channel_devices_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_org_id_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_permission_overrides: {
        Row: {
          channel_id: number
          created_at: string
          id: string
          is_allowed: boolean
          permission_key: string
          principal_id: string
          principal_type: string
        }
        Insert: {
          channel_id: number
          created_at?: string
          id?: string
          is_allowed: boolean
          permission_key: string
          principal_id: string
          principal_type: string
        }
        Update: {
          channel_id?: number
          created_at?: string
          id?: string
          is_allowed?: boolean
          permission_key?: string
          principal_id?: string
          principal_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_permission_overrides_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_permission_overrides_permission_key_fkey"
            columns: ["permission_key"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["key"]
          },
        ]
      }
      channels: {
        Row: {
          allow_dev: boolean
          allow_device: boolean
          allow_device_self_set: boolean
          allow_emulator: boolean
          allow_prod: boolean
          android: boolean
          app_id: string
          auto_pause_action: string
          auto_pause_confidence: number
          auto_pause_cooldown_minutes: number
          auto_pause_enabled: boolean
          auto_pause_failure_rate_bps: number | null
          auto_pause_last_checked_at: string | null
          auto_pause_last_triggered_at: string | null
          auto_pause_min_attempts: number | null
          auto_pause_min_failures: number | null
          auto_pause_window_minutes: number
          created_at: string
          created_by: string
          disable_auto_update: Database["public"]["Enums"]["disable_update"]
          disable_auto_update_under_native: boolean
          electron: boolean
          id: number
          ios: boolean
          name: string
          owner_org: string
          public: boolean
          rbac_id: string
          rollout_cache_ttl_seconds: number
          rollout_enabled: boolean
          rollout_id: string
          rollout_pause_reason: string | null
          rollout_paused_at: string | null
          rollout_percentage_bps: number
          rollout_version: number | null
          updated_at: string
          version: number | null
        }
        Insert: {
          allow_dev?: boolean
          allow_device?: boolean
          allow_device_self_set?: boolean
          allow_emulator?: boolean
          allow_prod?: boolean
          android?: boolean
          app_id: string
          auto_pause_action?: string
          auto_pause_confidence?: number
          auto_pause_cooldown_minutes?: number
          auto_pause_enabled?: boolean
          auto_pause_failure_rate_bps?: number | null
          auto_pause_last_checked_at?: string | null
          auto_pause_last_triggered_at?: string | null
          auto_pause_min_attempts?: number | null
          auto_pause_min_failures?: number | null
          auto_pause_window_minutes?: number
          created_at?: string
          created_by: string
          disable_auto_update?: Database["public"]["Enums"]["disable_update"]
          disable_auto_update_under_native?: boolean
          electron?: boolean
          id?: number
          ios?: boolean
          name: string
          owner_org: string
          public?: boolean
          rbac_id?: string
          rollout_cache_ttl_seconds?: number
          rollout_enabled?: boolean
          rollout_id?: string
          rollout_pause_reason?: string | null
          rollout_paused_at?: string | null
          rollout_percentage_bps?: number
          rollout_version?: number | null
          updated_at?: string
          version?: number | null
        }
        Update: {
          allow_dev?: boolean
          allow_device?: boolean
          allow_device_self_set?: boolean
          allow_emulator?: boolean
          allow_prod?: boolean
          android?: boolean
          app_id?: string
          auto_pause_action?: string
          auto_pause_confidence?: number
          auto_pause_cooldown_minutes?: number
          auto_pause_enabled?: boolean
          auto_pause_failure_rate_bps?: number | null
          auto_pause_last_checked_at?: string | null
          auto_pause_last_triggered_at?: string | null
          auto_pause_min_attempts?: number | null
          auto_pause_min_failures?: number | null
          auto_pause_window_minutes?: number
          created_at?: string
          created_by?: string
          disable_auto_update?: Database["public"]["Enums"]["disable_update"]
          disable_auto_update_under_native?: boolean
          electron?: boolean
          id?: number
          ios?: boolean
          name?: string
          owner_org?: string
          public?: boolean
          rbac_id?: string
          rollout_cache_ttl_seconds?: number
          rollout_enabled?: boolean
          rollout_id?: string
          rollout_pause_reason?: string | null
          rollout_paused_at?: string | null
          rollout_percentage_bps?: number
          rollout_version?: number | null
          updated_at?: string
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "channels_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "channels_rollout_version_fkey"
            columns: ["rollout_version"]
            isOneToOne: false
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channels_version_fkey"
            columns: ["version"]
            isOneToOne: false
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_org_id_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      compatibility_events: {
        Row: {
          app_id: string
          change_occurred_at: string
          channel_id: number | null
          channel_name: string
          created_at: string
          current_version_id: number | null
          current_version_name: string
          id: number
          offenders: Json
          org_id: string
          platform: string
          previous_version_id: number | null
          previous_version_name: string
          resolution_kind: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          source: string
        }
        Insert: {
          app_id: string
          change_occurred_at?: string
          channel_id?: number | null
          channel_name: string
          created_at?: string
          current_version_id?: number | null
          current_version_name: string
          id?: never
          offenders?: Json
          org_id: string
          platform: string
          previous_version_id?: number | null
          previous_version_name: string
          resolution_kind?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source: string
        }
        Update: {
          app_id?: string
          change_occurred_at?: string
          channel_id?: number | null
          channel_name?: string
          created_at?: string
          current_version_id?: number | null
          current_version_name?: string
          id?: never
          offenders?: Json
          org_id?: string
          platform?: string
          previous_version_id?: number | null
          previous_version_name?: string
          resolution_kind?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "compatibility_events_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "compatibility_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_tasks: {
        Row: {
          batch_size: number | null
          created_at: string
          description: string | null
          enabled: boolean
          healthcheck_url: string | null
          hour_interval: number | null
          id: number
          minute_interval: number | null
          name: string
          payload: Json | null
          run_at_hour: number | null
          run_at_minute: number | null
          run_at_second: number | null
          run_on_day: number | null
          run_on_dow: number | null
          second_interval: number | null
          target: string
          task_type: Database["public"]["Enums"]["cron_task_type"]
          updated_at: string
        }
        Insert: {
          batch_size?: number | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          healthcheck_url?: string | null
          hour_interval?: number | null
          id?: number
          minute_interval?: number | null
          name: string
          payload?: Json | null
          run_at_hour?: number | null
          run_at_minute?: number | null
          run_at_second?: number | null
          run_on_day?: number | null
          run_on_dow?: number | null
          second_interval?: number | null
          target: string
          task_type?: Database["public"]["Enums"]["cron_task_type"]
          updated_at?: string
        }
        Update: {
          batch_size?: number | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          healthcheck_url?: string | null
          hour_interval?: number | null
          id?: number
          minute_interval?: number | null
          name?: string
          payload?: Json | null
          run_at_hour?: number | null
          run_at_minute?: number | null
          run_at_second?: number | null
          run_on_day?: number | null
          run_on_dow?: number | null
          second_interval?: number | null
          target?: string
          task_type?: Database["public"]["Enums"]["cron_task_type"]
          updated_at?: string
        }
        Relationships: []
      }
      daily_bandwidth: {
        Row: {
          app_id: string
          bandwidth: number
          date: string
          id: number
        }
        Insert: {
          app_id: string
          bandwidth: number
          date: string
          id?: number
        }
        Update: {
          app_id?: string
          bandwidth?: number
          date?: string
          id?: number
        }
        Relationships: []
      }
      daily_build_time: {
        Row: {
          app_id: string
          build_count: number
          build_time_unit: number
          date: string
        }
        Insert: {
          app_id: string
          build_count?: number
          build_time_unit?: number
          date: string
        }
        Update: {
          app_id?: string
          build_count?: number
          build_time_unit?: number
          date?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_build_time_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
        ]
      }
      daily_mau: {
        Row: {
          app_id: string
          date: string
          id: number
          mau: number
        }
        Insert: {
          app_id: string
          date: string
          id?: number
          mau: number
        }
        Update: {
          app_id?: string
          date?: string
          id?: number
          mau?: number
        }
        Relationships: []
      }
      daily_revenue_metrics: {
        Row: {
          churn_mrr: number
          churn_mrr_enterprise: number
          churn_mrr_maker: number
          churn_mrr_solo: number
          churn_mrr_team: number
          churn_reason: string | null
          contraction_mrr: number
          contraction_mrr_enterprise: number
          contraction_mrr_maker: number
          contraction_mrr_solo: number
          contraction_mrr_team: number
          created_at: string
          customer_id: string
          date_id: string
          expansion_mrr: number
          new_business_mrr: number
          opening_mrr: number
          updated_at: string
        }
        Insert: {
          churn_mrr?: number
          churn_mrr_enterprise?: number
          churn_mrr_maker?: number
          churn_mrr_solo?: number
          churn_mrr_team?: number
          churn_reason?: string | null
          contraction_mrr?: number
          contraction_mrr_enterprise?: number
          contraction_mrr_maker?: number
          contraction_mrr_solo?: number
          contraction_mrr_team?: number
          created_at?: string
          customer_id: string
          date_id: string
          expansion_mrr?: number
          new_business_mrr?: number
          opening_mrr?: number
          updated_at?: string
        }
        Update: {
          churn_mrr?: number
          churn_mrr_enterprise?: number
          churn_mrr_maker?: number
          churn_mrr_solo?: number
          churn_mrr_team?: number
          churn_reason?: string | null
          contraction_mrr?: number
          contraction_mrr_enterprise?: number
          contraction_mrr_maker?: number
          contraction_mrr_solo?: number
          contraction_mrr_team?: number
          created_at?: string
          customer_id?: string
          date_id?: string
          expansion_mrr?: number
          new_business_mrr?: number
          opening_mrr?: number
          updated_at?: string
        }
        Relationships: []
      }
      daily_storage: {
        Row: {
          app_id: string
          date: string
          id: number
          storage: number
        }
        Insert: {
          app_id: string
          date: string
          id?: number
          storage: number
        }
        Update: {
          app_id?: string
          date?: string
          id?: number
          storage?: number
        }
        Relationships: []
      }
      daily_storage_hourly: {
        Row: {
          app_id: string
          created_at: string
          date: string
          owner_org: string
          storage_byte_hours: number
          updated_at: string
        }
        Insert: {
          app_id: string
          created_at?: string
          date: string
          owner_org: string
          storage_byte_hours?: number
          updated_at?: string
        }
        Update: {
          app_id?: string
          created_at?: string
          date?: string
          owner_org?: string
          storage_byte_hours?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_storage_hourly_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "daily_storage_hourly_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_version: {
        Row: {
          app_id: string
          date: string
          fail: number | null
          get: number | null
          install: number | null
          uninstall: number | null
          version_id: number | null
          version_name: string
        }
        Insert: {
          app_id: string
          date: string
          fail?: number | null
          get?: number | null
          install?: number | null
          uninstall?: number | null
          version_id?: number | null
          version_name: string
        }
        Update: {
          app_id?: string
          date?: string
          fail?: number | null
          get?: number | null
          install?: number | null
          uninstall?: number | null
          version_id?: number | null
          version_name?: string
        }
        Relationships: []
      }
      deleted_account: {
        Row: {
          created_at: string | null
          email: string
          id: string
        }
        Insert: {
          created_at?: string | null
          email?: string
          id?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
        }
        Relationships: []
      }
      deleted_apps: {
        Row: {
          app_id: string
          created_at: string | null
          deleted_at: string | null
          id: number
          owner_org: string
          transfer_history: Json[] | null
        }
        Insert: {
          app_id: string
          created_at?: string | null
          deleted_at?: string | null
          id?: number
          owner_org: string
          transfer_history?: Json[] | null
        }
        Update: {
          app_id?: string
          created_at?: string | null
          deleted_at?: string | null
          id?: number
          owner_org?: string
          transfer_history?: Json[] | null
        }
        Relationships: []
      }
      deploy_history: {
        Row: {
          app_id: string
          channel_id: number
          created_at: string | null
          created_by: string
          deployed_at: string | null
          id: number
          install_stats_email_sent_at: string | null
          owner_org: string
          updated_at: string | null
          version_id: number
        }
        Insert: {
          app_id: string
          channel_id: number
          created_at?: string | null
          created_by: string
          deployed_at?: string | null
          id?: number
          install_stats_email_sent_at?: string | null
          owner_org: string
          updated_at?: string | null
          version_id: number
        }
        Update: {
          app_id?: string
          channel_id?: number
          created_at?: string | null
          created_by?: string
          deployed_at?: string | null
          id?: number
          install_stats_email_sent_at?: string | null
          owner_org?: string
          updated_at?: string | null
          version_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "deploy_history_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "deploy_history_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deploy_history_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deploy_history_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      device_usage: {
        Row: {
          app_id: string
          device_id: string
          id: number
          org_id: string
          platform: string | null
          timestamp: string
          version_build: string | null
        }
        Insert: {
          app_id: string
          device_id: string
          id?: number
          org_id: string
          platform?: string | null
          timestamp?: string
          version_build?: string | null
        }
        Update: {
          app_id?: string
          device_id?: string
          id?: number
          org_id?: string
          platform?: string | null
          timestamp?: string
          version_build?: string | null
        }
        Relationships: []
      }
      devices: {
        Row: {
          app_id: string
          country_code: string | null
          custom_id: string
          default_channel: string | null
          device_id: string
          id: number
          install_source: string | null
          is_emulator: boolean | null
          is_prod: boolean | null
          key_id: string | null
          os_version: string | null
          platform: Database["public"]["Enums"]["platform_os"]
          plugin_version: string
          updated_at: string
          version: number | null
          version_build: string | null
          version_name: string
        }
        Insert: {
          app_id: string
          country_code?: string | null
          custom_id?: string
          default_channel?: string | null
          device_id: string
          id?: never
          install_source?: string | null
          is_emulator?: boolean | null
          is_prod?: boolean | null
          key_id?: string | null
          os_version?: string | null
          platform: Database["public"]["Enums"]["platform_os"]
          plugin_version?: string
          updated_at: string
          version?: number | null
          version_build?: string | null
          version_name?: string
        }
        Update: {
          app_id?: string
          country_code?: string | null
          custom_id?: string
          default_channel?: string | null
          device_id?: string
          id?: never
          install_source?: string | null
          is_emulator?: boolean | null
          is_prod?: boolean | null
          key_id?: string | null
          os_version?: string | null
          platform?: Database["public"]["Enums"]["platform_os"]
          plugin_version?: string
          updated_at?: string
          version?: number | null
          version_build?: string | null
          version_name?: string
        }
        Relationships: []
      }
      global_stats: {
        Row: {
          above_plan_with_credits: number | null
          above_plan_without_credits: number | null
          active_canceled_orgs: number
          active_past_due_orgs: number
          apps: number
          apps_active: number | null
          apps_created: number
          apps_with_cli_onboarding_builds_24h: number
          apps_with_manual_builds_24h: number
          average_ltv: number
          build_avg_seconds_day_android: number
          build_avg_seconds_day_ios: number
          build_count_day_android: number
          build_count_day_ios: number
          build_total_seconds_day_android: number
          build_total_seconds_day_ios: number
          builder_active_paying_clients_60d: number
          builds_android: number | null
          builds_ios: number | null
          builds_last_month: number | null
          builds_last_month_android: number | null
          builds_last_month_ios: number | null
          builds_success_android: number | null
          builds_success_ios: number | null
          builds_success_total: number | null
          builds_total: number | null
          bundle_storage_gb: number
          canceled_orgs: number
          churn_revenue: number
          churn_revenue_enterprise: number
          churn_revenue_maker: number
          churn_revenue_solo: number
          churn_revenue_team: number
          completed_shards: Json
          created_at: string | null
          credits_bought: number
          credits_consumed: number
          date_id: string
          demo_apps_created: number
          devices_last_month: number | null
          devices_last_month_android: number | null
          devices_last_month_ios: number | null
          live_updates_active_paying_clients_60d: number
          longest_ltv: number
          mrr: number
          need_upgrade: number | null
          new_paying_orgs: number
          not_paying: number | null
          nrr: number
          onboarded: number | null
          org_conversion_rate: number
          orgs: number
          past_due_orgs: number
          past_due_orgs_average_days: number
          paying: number | null
          paying_monthly: number | null
          paying_yearly: number | null
          plan_enterprise: number | null
          plan_enterprise_conversion_rate: number
          plan_enterprise_monthly: number
          plan_enterprise_yearly: number
          plan_maker: number | null
          plan_maker_conversion_rate: number
          plan_maker_monthly: number
          plan_maker_yearly: number
          plan_solo: number | null
          plan_solo_conversion_rate: number
          plan_solo_monthly: number
          plan_solo_yearly: number
          plan_team: number | null
          plan_team_conversion_rate: number
          plan_team_monthly: number
          plan_team_yearly: number
          plan_total_conversion_rate: number
          plugin_major_breakdown: Json
          plugin_version_breakdown: Json
          plugin_version_ladder: Json
          registers_today: number
          revenue_enterprise: number
          revenue_maker: number
          revenue_solo: number
          revenue_team: number
          shortest_ltv: number
          stars: number
          success_rate: number | null
          total_revenue: number
          trial: number | null
          trial_extended_orgs: number
          trial_extended_subscribed_orgs: number
          updates: number
          updates_external: number | null
          updates_last_month: number | null
          upgrade_rate_12m: number
          upgraded_orgs: number
          users: number | null
          users_active: number | null
        }
        Insert: {
          above_plan_with_credits?: number | null
          above_plan_without_credits?: number | null
          active_canceled_orgs?: number
          active_past_due_orgs?: number
          apps: number
          apps_active?: number | null
          apps_created?: number
          apps_with_cli_onboarding_builds_24h?: number
          apps_with_manual_builds_24h?: number
          average_ltv?: number
          build_avg_seconds_day_android?: number
          build_avg_seconds_day_ios?: number
          build_count_day_android?: number
          build_count_day_ios?: number
          build_total_seconds_day_android?: number
          build_total_seconds_day_ios?: number
          builder_active_paying_clients_60d?: number
          builds_android?: number | null
          builds_ios?: number | null
          builds_last_month?: number | null
          builds_last_month_android?: number | null
          builds_last_month_ios?: number | null
          builds_success_android?: number | null
          builds_success_ios?: number | null
          builds_success_total?: number | null
          builds_total?: number | null
          bundle_storage_gb?: number
          canceled_orgs?: number
          churn_revenue?: number
          churn_revenue_enterprise?: number
          churn_revenue_maker?: number
          churn_revenue_solo?: number
          churn_revenue_team?: number
          completed_shards?: Json
          created_at?: string | null
          credits_bought?: number
          credits_consumed?: number
          date_id: string
          demo_apps_created?: number
          devices_last_month?: number | null
          devices_last_month_android?: number | null
          devices_last_month_ios?: number | null
          live_updates_active_paying_clients_60d?: number
          longest_ltv?: number
          mrr?: number
          need_upgrade?: number | null
          new_paying_orgs?: number
          not_paying?: number | null
          nrr?: number
          onboarded?: number | null
          org_conversion_rate?: number
          orgs?: number
          past_due_orgs?: number
          past_due_orgs_average_days?: number
          paying?: number | null
          paying_monthly?: number | null
          paying_yearly?: number | null
          plan_enterprise?: number | null
          plan_enterprise_conversion_rate?: number
          plan_enterprise_monthly?: number
          plan_enterprise_yearly?: number
          plan_maker?: number | null
          plan_maker_conversion_rate?: number
          plan_maker_monthly?: number
          plan_maker_yearly?: number
          plan_solo?: number | null
          plan_solo_conversion_rate?: number
          plan_solo_monthly?: number
          plan_solo_yearly?: number
          plan_team?: number | null
          plan_team_conversion_rate?: number
          plan_team_monthly?: number
          plan_team_yearly?: number
          plan_total_conversion_rate?: number
          plugin_major_breakdown?: Json
          plugin_version_breakdown?: Json
          plugin_version_ladder?: Json
          registers_today?: number
          revenue_enterprise?: number
          revenue_maker?: number
          revenue_solo?: number
          revenue_team?: number
          shortest_ltv?: number
          stars: number
          success_rate?: number | null
          total_revenue?: number
          trial?: number | null
          trial_extended_orgs?: number
          trial_extended_subscribed_orgs?: number
          updates: number
          updates_external?: number | null
          updates_last_month?: number | null
          upgrade_rate_12m?: number
          upgraded_orgs?: number
          users?: number | null
          users_active?: number | null
        }
        Update: {
          above_plan_with_credits?: number | null
          above_plan_without_credits?: number | null
          active_canceled_orgs?: number
          active_past_due_orgs?: number
          apps?: number
          apps_active?: number | null
          apps_created?: number
          apps_with_cli_onboarding_builds_24h?: number
          apps_with_manual_builds_24h?: number
          average_ltv?: number
          build_avg_seconds_day_android?: number
          build_avg_seconds_day_ios?: number
          build_count_day_android?: number
          build_count_day_ios?: number
          build_total_seconds_day_android?: number
          build_total_seconds_day_ios?: number
          builder_active_paying_clients_60d?: number
          builds_android?: number | null
          builds_ios?: number | null
          builds_last_month?: number | null
          builds_last_month_android?: number | null
          builds_last_month_ios?: number | null
          builds_success_android?: number | null
          builds_success_ios?: number | null
          builds_success_total?: number | null
          builds_total?: number | null
          bundle_storage_gb?: number
          canceled_orgs?: number
          churn_revenue?: number
          churn_revenue_enterprise?: number
          churn_revenue_maker?: number
          churn_revenue_solo?: number
          churn_revenue_team?: number
          completed_shards?: Json
          created_at?: string | null
          credits_bought?: number
          credits_consumed?: number
          date_id?: string
          demo_apps_created?: number
          devices_last_month?: number | null
          devices_last_month_android?: number | null
          devices_last_month_ios?: number | null
          live_updates_active_paying_clients_60d?: number
          longest_ltv?: number
          mrr?: number
          need_upgrade?: number | null
          new_paying_orgs?: number
          not_paying?: number | null
          nrr?: number
          onboarded?: number | null
          org_conversion_rate?: number
          orgs?: number
          past_due_orgs?: number
          past_due_orgs_average_days?: number
          paying?: number | null
          paying_monthly?: number | null
          paying_yearly?: number | null
          plan_enterprise?: number | null
          plan_enterprise_conversion_rate?: number
          plan_enterprise_monthly?: number
          plan_enterprise_yearly?: number
          plan_maker?: number | null
          plan_maker_conversion_rate?: number
          plan_maker_monthly?: number
          plan_maker_yearly?: number
          plan_solo?: number | null
          plan_solo_conversion_rate?: number
          plan_solo_monthly?: number
          plan_solo_yearly?: number
          plan_team?: number | null
          plan_team_conversion_rate?: number
          plan_team_monthly?: number
          plan_team_yearly?: number
          plan_total_conversion_rate?: number
          plugin_major_breakdown?: Json
          plugin_version_breakdown?: Json
          plugin_version_ladder?: Json
          registers_today?: number
          revenue_enterprise?: number
          revenue_maker?: number
          revenue_solo?: number
          revenue_team?: number
          shortest_ltv?: number
          stars?: number
          success_rate?: number | null
          total_revenue?: number
          trial?: number | null
          trial_extended_orgs?: number
          trial_extended_subscribed_orgs?: number
          updates?: number
          updates_external?: number | null
          updates_last_month?: number | null
          upgrade_rate_12m?: number
          upgraded_orgs?: number
          users?: number | null
          users_active?: number | null
        }
        Relationships: []
      }
      group_members: {
        Row: {
          added_at: string
          added_by: string | null
          group_id: string
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          group_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          group_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_system: boolean
          name: string
          org_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_system?: boolean
          name: string
          org_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      manifest: {
        Row: {
          app_version_id: number
          file_hash: string
          file_name: string
          file_size: number | null
          id: number
          s3_path: string
        }
        Insert: {
          app_version_id: number
          file_hash: string
          file_name: string
          file_size?: number | null
          id?: number
          s3_path: string
        }
        Update: {
          app_version_id?: number
          file_hash?: string
          file_name?: string
          file_size?: number | null
          id?: number
          s3_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "manifest_app_version_id_fkey"
            columns: ["app_version_id"]
            isOneToOne: false
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_app_settings: {
        Row: {
          app_id: string
          created_at: string
          created_by: string | null
          id: string
          owner_org: string
          push_update_channel: string | null
          push_update_enabled: boolean
          push_update_install_mode: string
          updated_at: string
        }
        Insert: {
          app_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          owner_org: string
          push_update_channel?: string | null
          push_update_enabled?: boolean
          push_update_install_mode?: string
          updated_at?: string
        }
        Update: {
          app_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          owner_org?: string
          push_update_channel?: string | null
          push_update_enabled?: boolean
          push_update_install_mode?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_app_settings_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: true
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "notification_app_settings_owner_org_app_id_fkey"
            columns: ["owner_org", "app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["owner_org", "app_id"]
          },
          {
            foreignKeyName: "notification_app_settings_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_campaigns: {
        Row: {
          app_id: string
          audience: Json
          completed_at: string | null
          counters: Json
          created_at: string
          created_by: string | null
          id: string
          kind: string
          name: string
          owner_org: string
          payload: Json
          queued_at: string | null
          scheduled_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          app_id: string
          audience?: Json
          completed_at?: string | null
          counters?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name: string
          owner_org: string
          payload?: Json
          queued_at?: string | null
          scheduled_at?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          app_id?: string
          audience?: Json
          completed_at?: string | null
          counters?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name?: string
          owner_org?: string
          payload?: Json
          queued_at?: string | null
          scheduled_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_campaigns_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "notification_campaigns_owner_org_app_id_fkey"
            columns: ["owner_org", "app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["owner_org", "app_id"]
          },
          {
            foreignKeyName: "notification_campaigns_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_provider_configs: {
        Row: {
          app_id: string
          config: Json
          created_at: string
          created_by: string | null
          id: string
          owner_org: string
          provider: string
          secret_ref: string | null
          status: string
          updated_at: string
        }
        Insert: {
          app_id: string
          config?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          owner_org: string
          provider: string
          secret_ref?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          app_id?: string
          config?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          owner_org?: string
          provider?: string
          secret_ref?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_provider_configs_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "notification_provider_configs_owner_org_app_id_fkey"
            columns: ["owner_org", "app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["owner_org", "app_id"]
          },
          {
            foreignKeyName: "notification_provider_configs_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string | null
          event: string
          last_send_at: string
          owner_org: string
          total_send: number
          uniq_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          event: string
          last_send_at?: string
          owner_org: string
          total_send?: number
          uniq_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          event?: string
          last_send_at?: string
          owner_org?: string
          total_send?: number
          uniq_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_org_id_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_demo_data: {
        Row: {
          app_id: string
          created_at: string
          id: string
          owner_org: string
          relation_name: string
          row_key: string
          seed_id: string
        }
        Insert: {
          app_id: string
          created_at?: string
          id?: string
          owner_org: string
          relation_name: string
          row_key: string
          seed_id: string
        }
        Update: {
          app_id?: string
          created_at?: string
          id?: string
          owner_org?: string
          relation_name?: string
          row_key?: string
          seed_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_demo_data_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "onboarding_demo_data_owner_org_fkey"
            columns: ["owner_org"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_id_tombstones: {
        Row: {
          deleted_at: string
          org_id: string
        }
        Insert: {
          deleted_at?: string
          org_id: string
        }
        Update: {
          deleted_at?: string
          org_id?: string
        }
        Relationships: []
      }
      org_metrics_cache: {
        Row: {
          bandwidth: number
          build_time_unit: number
          cached_at: string
          end_date: string
          fail: number
          get: number
          install: number
          mau: number
          org_id: string
          start_date: string
          storage: number
          uninstall: number
        }
        Insert: {
          bandwidth: number
          build_time_unit: number
          cached_at?: string
          end_date: string
          fail: number
          get: number
          install: number
          mau: number
          org_id: string
          start_date: string
          storage: number
          uninstall: number
        }
        Update: {
          bandwidth?: number
          build_time_unit?: number
          cached_at?: string
          end_date?: string
          fail?: number
          get?: number
          install?: number
          mau?: number
          org_id?: string
          start_date?: string
          storage?: number
          uninstall?: number
        }
        Relationships: [
          {
            foreignKeyName: "org_metrics_cache_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_users: {
        Row: {
          app_id: string | null
          channel_id: number | null
          created_at: string | null
          id: number
          is_invite: boolean
          org_id: string
          rbac_role_name: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          app_id?: string | null
          channel_id?: number | null
          created_at?: string | null
          id?: number
          is_invite?: boolean
          org_id: string
          rbac_role_name?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          app_id?: string | null
          channel_id?: number | null
          created_at?: string | null
          id?: number
          is_invite?: boolean
          org_id?: string
          rbac_role_name?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_users_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["app_id"]
          },
          {
            foreignKeyName: "org_users_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_users_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          created_at: string | null
          created_by: string
          customer_id: string | null
          email_preferences: Json
          enforce_encrypted_bundles: boolean
          enforce_hashed_api_keys: boolean
          enforcing_2fa: boolean
          has_usage_credits: boolean
          id: string
          last_stats_updated_at: string | null
          logo: string | null
          management_email: string
          max_apikey_expiration_days: number | null
          name: string
          onboarding: Json
          password_policy_config: Json | null
          require_apikey_expiration: boolean
          required_encryption_key: string | null
          stats_refresh_requested_at: string | null
          stats_updated_at: string | null
          updated_at: string | null
          website: string | null
        }
        Insert: {
          created_at?: string | null
          created_by: string
          customer_id?: string | null
          email_preferences?: Json
          enforce_encrypted_bundles?: boolean
          enforce_hashed_api_keys?: boolean
          enforcing_2fa?: boolean
          has_usage_credits?: boolean
          id?: string
          last_stats_updated_at?: string | null
          logo?: string | null
          management_email: string
          max_apikey_expiration_days?: number | null
          name: string
          onboarding?: Json
          password_policy_config?: Json | null
          require_apikey_expiration?: boolean
          required_encryption_key?: string | null
          stats_refresh_requested_at?: string | null
          stats_updated_at?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string
          customer_id?: string | null
          email_preferences?: Json
          enforce_encrypted_bundles?: boolean
          enforce_hashed_api_keys?: boolean
          enforcing_2fa?: boolean
          has_usage_credits?: boolean
          id?: string
          last_stats_updated_at?: string | null
          logo?: string | null
          management_email?: string
          max_apikey_expiration_days?: number | null
          name?: string
          onboarding?: Json
          password_policy_config?: Json | null
          require_apikey_expiration?: boolean
          required_encryption_key?: string | null
          stats_refresh_requested_at?: string | null
          stats_updated_at?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orgs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orgs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "stripe_info"
            referencedColumns: ["customer_id"]
          },
        ]
      }
      permissions: {
        Row: {
          bundle_id: number | null
          created_at: string
          description: string | null
          id: string
          key: string
          scope_type: string
        }
        Insert: {
          bundle_id?: number | null
          created_at?: string
          description?: string | null
          id?: string
          key: string
          scope_type: string
        }
        Update: {
          bundle_id?: number | null
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          scope_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "permissions_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          bandwidth: number
          build_time_unit: number
          created_at: string
          credit_id: string
          description: string
          id: string
          market_desc: string | null
          mau: number
          name: string
          native_build_concurrency: number
          price_m: number
          price_m_id: string
          price_y: number
          price_y_id: string
          storage: number
          stripe_id: string
          updated_at: string
        }
        Insert: {
          bandwidth: number
          build_time_unit?: number
          created_at?: string
          credit_id: string
          description?: string
          id?: string
          market_desc?: string | null
          mau?: number
          name?: string
          native_build_concurrency?: number
          price_m?: number
          price_m_id: string
          price_y?: number
          price_y_id: string
          storage: number
          stripe_id?: string
          updated_at?: string
        }
        Update: {
          bandwidth?: number
          build_time_unit?: number
          created_at?: string
          credit_id?: string
          description?: string
          id?: string
          market_desc?: string | null
          mau?: number
          name?: string
          native_build_concurrency?: number
          price_m?: number
          price_m_id?: string
          price_y?: number
          price_y_id?: string
          storage?: number
          stripe_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      processed_stripe_events: {
        Row: {
          created_at: string
          customer_id: string
          date_id: string
          event_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          date_id: string
          event_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          date_id?: string
          event_id?: string
        }
        Relationships: []
      }
      role_bindings: {
        Row: {
          app_id: string | null
          bundle_id: number | null
          channel_id: string | null
          expires_at: string | null
          granted_at: string
          granted_by: string
          id: string
          is_direct: boolean
          org_id: string | null
          parent_binding_id: string | null
          principal_id: string
          principal_type: string
          reason: string | null
          role_id: string
          scope_type: string
        }
        Insert: {
          app_id?: string | null
          bundle_id?: number | null
          channel_id?: string | null
          expires_at?: string | null
          granted_at?: string
          granted_by: string
          id?: string
          is_direct?: boolean
          org_id?: string | null
          parent_binding_id?: string | null
          principal_id: string
          principal_type: string
          reason?: string | null
          role_id: string
          scope_type: string
        }
        Update: {
          app_id?: string | null
          bundle_id?: number | null
          channel_id?: string | null
          expires_at?: string | null
          granted_at?: string
          granted_by?: string
          id?: string
          is_direct?: boolean
          org_id?: string | null
          parent_binding_id?: string | null
          principal_id?: string
          principal_type?: string
          reason?: string | null
          role_id?: string
          scope_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_bindings_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_bindings_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "app_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_bindings_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["rbac_id"]
          },
          {
            foreignKeyName: "role_bindings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_bindings_parent_binding_id_fkey"
            columns: ["parent_binding_id"]
            isOneToOne: false
            referencedRelation: "role_bindings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_bindings_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_hierarchy: {
        Row: {
          child_role_id: string
          parent_role_id: string
        }
        Insert: {
          child_role_id: string
          parent_role_id: string
        }
        Update: {
          child_role_id?: string
          parent_role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_hierarchy_child_role_id_fkey"
            columns: ["child_role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_hierarchy_parent_role_id_fkey"
            columns: ["parent_role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_assignable: boolean
          name: string
          priority_rank: number
          scope_type: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_assignable?: boolean
          name: string
          priority_rank?: number
          scope_type: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_assignable?: boolean
          name?: string
          priority_rank?: number
          scope_type?: string
        }
        Relationships: []
      }
      sso_providers: {
        Row: {
          attribute_mapping: Json | null
          created_at: string
          dns_verification_token: string
          dns_verified_at: string | null
          domain: string
          enforce_sso: boolean
          id: string
          metadata_url: string | null
          org_id: string
          provider_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attribute_mapping?: Json | null
          created_at?: string
          dns_verification_token: string
          dns_verified_at?: string | null
          domain: string
          enforce_sso?: boolean
          id?: string
          metadata_url?: string | null
          org_id: string
          provider_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attribute_mapping?: Json | null
          created_at?: string
          dns_verification_token?: string
          dns_verified_at?: string | null
          domain?: string
          enforce_sso?: boolean
          id?: string
          metadata_url?: string | null
          org_id?: string
          provider_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sso_providers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      stats: {
        Row: {
          action: Database["public"]["Enums"]["stats_action"]
          app_id: string
          created_at: string
          device_id: string
          id: number
          metadata: Json | null
          version_name: string
        }
        Insert: {
          action: Database["public"]["Enums"]["stats_action"]
          app_id: string
          created_at: string
          device_id: string
          id?: never
          metadata?: Json | null
          version_name?: string
        }
        Update: {
          action?: Database["public"]["Enums"]["stats_action"]
          app_id?: string
          created_at?: string
          device_id?: string
          id?: never
          metadata?: Json | null
          version_name?: string
        }
        Relationships: []
      }
      storage_usage: {
        Row: {
          app_id: string
          device_id: string
          file_size: number
          id: number
          timestamp: string
        }
        Insert: {
          app_id: string
          device_id: string
          file_size: number
          id?: number
          timestamp?: string
        }
        Update: {
          app_id?: string
          device_id?: string
          file_size?: number
          id?: number
          timestamp?: string
        }
        Relationships: []
      }
      stripe_info: {
        Row: {
          bandwidth_exceeded: boolean | null
          build_time_exceeded: boolean | null
          canceled_at: string | null
          churn_reason: string | null
          created_at: string
          customer_country: string | null
          customer_id: string
          id: number
          is_above_plan: boolean | null
          is_good_plan: boolean | null
          last_stripe_event_at: string | null
          mau_exceeded: boolean | null
          paid_at: string | null
          past_due_at: string | null
          plan_calculated_at: string | null
          plan_usage: number | null
          price_id: string | null
          product_id: string
          status: Database["public"]["Enums"]["stripe_status"] | null
          storage_exceeded: boolean | null
          subscription_anchor_end: string
          subscription_anchor_start: string
          subscription_id: string | null
          trial_at: string
          updated_at: string
          upgraded_at: string | null
        }
        Insert: {
          bandwidth_exceeded?: boolean | null
          build_time_exceeded?: boolean | null
          canceled_at?: string | null
          churn_reason?: string | null
          created_at?: string
          customer_country?: string | null
          customer_id: string
          id?: number
          is_above_plan?: boolean | null
          is_good_plan?: boolean | null
          last_stripe_event_at?: string | null
          mau_exceeded?: boolean | null
          paid_at?: string | null
          past_due_at?: string | null
          plan_calculated_at?: string | null
          plan_usage?: number | null
          price_id?: string | null
          product_id: string
          status?: Database["public"]["Enums"]["stripe_status"] | null
          storage_exceeded?: boolean | null
          subscription_anchor_end?: string
          subscription_anchor_start?: string
          subscription_id?: string | null
          trial_at?: string
          updated_at?: string
          upgraded_at?: string | null
        }
        Update: {
          bandwidth_exceeded?: boolean | null
          build_time_exceeded?: boolean | null
          canceled_at?: string | null
          churn_reason?: string | null
          created_at?: string
          customer_country?: string | null
          customer_id?: string
          id?: number
          is_above_plan?: boolean | null
          is_good_plan?: boolean | null
          last_stripe_event_at?: string | null
          mau_exceeded?: boolean | null
          paid_at?: string | null
          past_due_at?: string | null
          plan_calculated_at?: string | null
          plan_usage?: number | null
          price_id?: string | null
          product_id?: string
          status?: Database["public"]["Enums"]["stripe_status"] | null
          storage_exceeded?: boolean | null
          subscription_anchor_end?: string
          subscription_anchor_start?: string
          subscription_id?: string | null
          trial_at?: string
          updated_at?: string
          upgraded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_info_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["stripe_id"]
          },
        ]
      }
      tmp_users: {
        Row: {
          cancelled_at: string | null
          created_at: string
          email: string
          first_name: string
          future_uuid: string
          id: number
          invite_magic_string: string
          last_name: string
          org_id: string
          rbac_role_name: string
          updated_at: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string
          email: string
          first_name: string
          future_uuid?: string
          id?: number
          invite_magic_string?: string
          last_name: string
          org_id: string
          rbac_role_name?: string
          updated_at?: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string
          email?: string
          first_name?: string
          future_uuid?: string
          id?: number
          invite_magic_string?: string
          last_name?: string
          org_id?: string
          rbac_role_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tmp_users_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      to_delete_accounts: {
        Row: {
          account_id: string
          created_at: string
          id: number
          removal_date: string
          removed_data: Json | null
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: number
          removal_date: string
          removed_data?: Json | null
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: number
          removal_date?: string
          removed_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "to_delete_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trial_extension_events: {
        Row: {
          created_at: string
          customer_id: string
          extension_days: number
          id: number
          new_trial_at: string
          org_id: string
          previous_trial_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          extension_days: number
          id?: number
          new_trial_at: string
          org_id: string
          previous_trial_at: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          extension_days?: number
          id?: number
          new_trial_at?: string
          org_id?: string
          previous_trial_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trial_extension_events_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "stripe_info"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "trial_extension_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_credit_consumptions: {
        Row: {
          applied_at: string
          credits_used: number
          grant_id: string
          id: number
          metric: Database["public"]["Enums"]["credit_metric_type"]
          org_id: string
          overage_event_id: string | null
        }
        Insert: {
          applied_at?: string
          credits_used: number
          grant_id: string
          id?: number
          metric: Database["public"]["Enums"]["credit_metric_type"]
          org_id: string
          overage_event_id?: string | null
        }
        Update: {
          applied_at?: string
          credits_used?: number
          grant_id?: string
          id?: number
          metric?: Database["public"]["Enums"]["credit_metric_type"]
          org_id?: string
          overage_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_credit_consumptions_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "usage_credit_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_credit_consumptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_credit_consumptions_overage_event_id_fkey"
            columns: ["overage_event_id"]
            isOneToOne: false
            referencedRelation: "usage_overage_events"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_credit_grants: {
        Row: {
          credits_consumed: number
          credits_total: number
          expires_at: string
          granted_at: string
          id: string
          notes: string | null
          org_id: string
          source: string
          source_ref: Json | null
        }
        Insert: {
          credits_consumed?: number
          credits_total: number
          expires_at?: string
          granted_at?: string
          id?: string
          notes?: string | null
          org_id: string
          source?: string
          source_ref?: Json | null
        }
        Update: {
          credits_consumed?: number
          credits_total?: number
          expires_at?: string
          granted_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          source?: string
          source_ref?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_credit_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_credit_transactions: {
        Row: {
          amount: number
          balance_after: number | null
          description: string | null
          grant_id: string | null
          id: number
          occurred_at: string
          org_id: string
          source_ref: Json | null
          transaction_type: Database["public"]["Enums"]["credit_transaction_type"]
        }
        Insert: {
          amount: number
          balance_after?: number | null
          description?: string | null
          grant_id?: string | null
          id?: number
          occurred_at?: string
          org_id: string
          source_ref?: Json | null
          transaction_type: Database["public"]["Enums"]["credit_transaction_type"]
        }
        Update: {
          amount?: number
          balance_after?: number | null
          description?: string | null
          grant_id?: string | null
          id?: number
          occurred_at?: string
          org_id?: string
          source_ref?: Json | null
          transaction_type?: Database["public"]["Enums"]["credit_transaction_type"]
        }
        Relationships: [
          {
            foreignKeyName: "usage_credit_transactions_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "usage_credit_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_credit_transactions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_overage_events: {
        Row: {
          billing_cycle_end: string | null
          billing_cycle_start: string | null
          created_at: string
          credit_step_id: number | null
          credits_debited: number
          credits_estimated: number
          details: Json | null
          id: string
          metric: Database["public"]["Enums"]["credit_metric_type"]
          org_id: string
          overage_amount: number
        }
        Insert: {
          billing_cycle_end?: string | null
          billing_cycle_start?: string | null
          created_at?: string
          credit_step_id?: number | null
          credits_debited?: number
          credits_estimated: number
          details?: Json | null
          id?: string
          metric: Database["public"]["Enums"]["credit_metric_type"]
          org_id: string
          overage_amount: number
        }
        Update: {
          billing_cycle_end?: string | null
          billing_cycle_start?: string | null
          created_at?: string
          credit_step_id?: number | null
          credits_debited?: number
          credits_estimated?: number
          details?: Json | null
          id?: string
          metric?: Database["public"]["Enums"]["credit_metric_type"]
          org_id?: string
          overage_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "usage_overage_events_credit_step_id_fkey"
            columns: ["credit_step_id"]
            isOneToOne: false
            referencedRelation: "capgo_credits_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_overage_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      user_password_compliance: {
        Row: {
          created_at: string
          id: number
          org_id: string
          policy_hash: string
          updated_at: string
          user_id: string
          validated_at: string
        }
        Insert: {
          created_at?: string
          id?: number
          org_id: string
          policy_hash: string
          updated_at?: string
          user_id: string
          validated_at?: string
        }
        Update: {
          created_at?: string
          id?: number
          org_id?: string
          policy_hash?: string
          updated_at?: string
          user_id?: string
          validated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_password_compliance_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      user_security: {
        Row: {
          created_at: string
          email_otp_verified_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_otp_verified_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_otp_verified_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          ban_time: string | null
          country: string | null
          created_at: string | null
          created_via_invite: boolean
          discord_username: string | null
          email: string
          email_preferences: Json
          enable_notifications: boolean
          first_name: string | null
          format_locale: string | null
          github_username: string | null
          id: string
          image_url: string | null
          last_name: string | null
          opt_for_newsletters: boolean
          updated_at: string | null
        }
        Insert: {
          ban_time?: string | null
          country?: string | null
          created_at?: string | null
          created_via_invite?: boolean
          discord_username?: string | null
          email: string
          email_preferences?: Json
          enable_notifications?: boolean
          first_name?: string | null
          format_locale?: string | null
          github_username?: string | null
          id: string
          image_url?: string | null
          last_name?: string | null
          opt_for_newsletters?: boolean
          updated_at?: string | null
        }
        Update: {
          ban_time?: string | null
          country?: string | null
          created_at?: string | null
          created_via_invite?: boolean
          discord_username?: string | null
          email?: string
          email_preferences?: Json
          enable_notifications?: boolean
          first_name?: string | null
          format_locale?: string | null
          github_username?: string | null
          id?: string
          image_url?: string | null
          last_name?: string | null
          opt_for_newsletters?: boolean
          updated_at?: string | null
        }
        Relationships: []
      }
      version_meta: {
        Row: {
          app_id: string
          size: number
          timestamp: string
          version_id: number
        }
        Insert: {
          app_id: string
          size: number
          timestamp?: string
          version_id: number
        }
        Update: {
          app_id?: string
          size?: number
          timestamp?: string
          version_id?: number
        }
        Relationships: []
      }
      version_usage: {
        Row: {
          action: Database["public"]["Enums"]["version_action"]
          app_id: string
          channel_id: number | null
          channel_name: string | null
          timestamp: string
          version_id: number | null
          version_name: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["version_action"]
          app_id: string
          channel_id?: number | null
          channel_name?: string | null
          timestamp?: string
          version_id?: number | null
          version_name?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["version_action"]
          app_id?: string
          channel_id?: number | null
          channel_name?: string | null
          timestamp?: string
          version_id?: number | null
          version_name?: string | null
        }
        Relationships: []
      }
      webhook_deliveries: {
        Row: {
          attempt_count: number
          audit_log_id: number | null
          completed_at: string | null
          created_at: string
          delivery_version: string
          duration_ms: number | null
          event_type: string
          id: string
          max_attempts: number
          next_retry_at: string | null
          org_id: string
          request_payload: Json
          response_body: string | null
          response_headers: Json | null
          response_status: number | null
          status: string
          webhook_id: string
        }
        Insert: {
          attempt_count?: number
          audit_log_id?: number | null
          completed_at?: string | null
          created_at?: string
          delivery_version?: string
          duration_ms?: number | null
          event_type: string
          id?: string
          max_attempts?: number
          next_retry_at?: string | null
          org_id: string
          request_payload: Json
          response_body?: string | null
          response_headers?: Json | null
          response_status?: number | null
          status?: string
          webhook_id: string
        }
        Update: {
          attempt_count?: number
          audit_log_id?: number | null
          completed_at?: string | null
          created_at?: string
          delivery_version?: string
          duration_ms?: number | null
          event_type?: string
          id?: string
          max_attempts?: number
          next_retry_at?: string | null
          org_id?: string
          request_payload?: Json
          response_body?: string | null
          response_headers?: Json | null
          response_status?: number | null
          status?: string
          webhook_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_webhook_id_fkey"
            columns: ["webhook_id"]
            isOneToOne: false
            referencedRelation: "webhooks"
            referencedColumns: ["id"]
          },
        ]
      }
      webhooks: {
        Row: {
          created_at: string
          created_by: string
          delivery_version: string
          enabled: boolean
          events: string[]
          id: string
          name: string
          org_id: string
          secret: string
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          created_by: string
          delivery_version?: string
          enabled?: boolean
          events: string[]
          id?: string
          name: string
          org_id: string
          secret?: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          created_by?: string
          delivery_version?: string
          enabled?: boolean
          events?: string[]
          id?: string
          name?: string
          org_id?: string
          secret?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhooks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhooks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      usage_credit_balances: {
        Row: {
          available_credits: number | null
          next_expiration: string | null
          org_id: string | null
          total_credits: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_credit_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_credit_ledger: {
        Row: {
          amount: number | null
          balance_after: number | null
          billing_cycle_end: string | null
          billing_cycle_start: string | null
          description: string | null
          details: Json | null
          grant_allocations: Json | null
          id: number | null
          metric: Database["public"]["Enums"]["credit_metric_type"] | null
          occurred_at: string | null
          org_id: string | null
          overage_amount: number | null
          overage_event_id: string | null
          source_ref: Json | null
          transaction_type:
            | Database["public"]["Enums"]["credit_transaction_type"]
            | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_invitation_to_org: { Args: { org_id: string }; Returns: string }
      acknowledge_compatibility_event: {
        Args: { event_id: number; note: string }
        Returns: undefined
      }
      apikey_has_current_org_create_capability: {
        Args: { p_apikey_rbac_id: string }
        Returns: boolean
      }
      apikey_has_global_permission: {
        Args: { p_apikey: string; p_permission_key: string }
        Returns: boolean
      }
      app_has_real_bundle: { Args: { p_app_id: string }; Returns: boolean }
      app_versions_readable_app_ids: { Args: never; Returns: string[] }
      apply_usage_overage: {
        Args: {
          p_billing_cycle_end: string
          p_billing_cycle_start: string
          p_details?: Json
          p_metric: Database["public"]["Enums"]["credit_metric_type"]
          p_org_id: string
          p_overage_amount: number
        }
        Returns: {
          credit_step_id: number
          credits_applied: number
          credits_remaining: number
          credits_required: number
          overage_amount: number
          overage_covered: number
          overage_event_id: string
          overage_unpaid: number
        }[]
      }
      apps_readable_app_ids: { Args: never; Returns: string[] }
      assert_effective_super_admin_binding_removal:
        | { Args: { p_binding_id: string }; Returns: undefined }
        | {
            Args: { p_binding_id: string; p_error_code: string }
            Returns: undefined
          }
      assert_effective_super_admin_group_member_removal: {
        Args: { p_group_id: string; p_user_id: string }
        Returns: undefined
      }
      assert_effective_super_admin_group_removal: {
        Args: { p_group_id: string; p_org_id: string }
        Returns: undefined
      }
      assert_group_member_is_org_member: {
        Args: { p_group_id: string; p_user_id: string }
        Returns: undefined
      }
      assert_preview_bundle_owner: {
        Args: { p_app_id: string; p_owner_org: string; p_version_id: number }
        Returns: undefined
      }
      assert_request_principal_rank: {
        Args: {
          p_mutation: string
          p_org_id: string
          p_target_priority: number
        }
        Returns: undefined
      }
      audit_logs_allowed_orgs: { Args: never; Returns: string[] }
      calculate_credit_cost: {
        Args: {
          p_metric: Database["public"]["Enums"]["credit_metric_type"]
          p_overage_amount: number
        }
        Returns: {
          credit_cost_per_unit: number
          credit_step_id: number
          credits_required: number
        }[]
      }
      calculate_org_metrics_cache_entry: {
        Args: { p_end_date: string; p_org_id: string; p_start_date: string }
        Returns: {
          bandwidth: number
          build_time_unit: number
          cached_at: string
          end_date: string
          fail: number
          get: number
          install: number
          mau: number
          org_id: string
          start_date: string
          storage: number
          uninstall: number
        }
        SetofOptions: {
          from: "*"
          to: "org_metrics_cache"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      channel_forced_devices_denied_channel_ids: {
        Args: never
        Returns: number[]
      }
      channel_forced_devices_readable_channel_ids: {
        Args: never
        Returns: number[]
      }
      channel_permission_override_readable_channel_ids: {
        Args: never
        Returns: number[]
      }
      channel_read_denied_channel_ids: { Args: never; Returns: number[] }
      channel_readable_channel_ids: { Args: never; Returns: number[] }
      check_apikey_hashed_key_enforcement: {
        Args: { apikey_row: Database["public"]["Tables"]["apikeys"]["Row"] }
        Returns: boolean
      }
      check_domain_sso: {
        Args: { p_domain: string }
        Returns: {
          has_sso: boolean
          org_id: string
          provider_id: string
        }[]
      }
      check_org_encrypted_bundle_enforcement: {
        Args: { org_id: string; session_key: string }
        Returns: boolean
      }
      check_org_hashed_key_enforcement: {
        Args: {
          apikey_row: Database["public"]["Tables"]["apikeys"]["Row"]
          org_id: string
        }
        Returns: boolean
      }
      check_org_members_2fa_enabled: {
        Args: { org_id: string }
        Returns: {
          "2fa_enabled": boolean
          user_id: string
        }[]
      }
      check_org_members_password_policy: {
        Args: { org_id: string }
        Returns: {
          email: string
          first_name: string
          last_name: string
          password_policy_compliant: boolean
          user_id: string
        }[]
      }
      check_revert_to_builtin_version: {
        Args: { appid: string }
        Returns: number
      }
      claim_legacy_onboarding_demo_data: {
        Args: { p_app_uuid: string }
        Returns: undefined
      }
      cleanup_completed_onboarding_apps: { Args: never; Returns: undefined }
      cleanup_expired_apikeys: { Args: never; Returns: undefined }
      cleanup_expired_demo_apps: { Args: never; Returns: undefined }
      cleanup_frequent_job_details: { Args: never; Returns: undefined }
      cleanup_job_run_details_7days: { Args: never; Returns: undefined }
      cleanup_net_http_response: { Args: never; Returns: undefined }
      cleanup_old_audit_logs: {
        Args: { batch_size?: number; max_batches?: number }
        Returns: undefined
      }
      cleanup_old_channel_devices: { Args: never; Returns: undefined }
      cleanup_queue_messages: {
        Args: { batch_size?: number; max_batches_total?: number }
        Returns: undefined
      }
      cleanup_tmp_users: { Args: never; Returns: undefined }
      cleanup_webhook_deliveries: { Args: never; Returns: undefined }
      clear_onboarding_app_data:
        | { Args: { p_app_uuid: string }; Returns: undefined }
        | {
            Args: { p_app_uuid: string; p_preserve_app_version_id: number }
            Returns: undefined
          }
      cli_check_permission: {
        Args: {
          apikey?: string
          app_id?: string
          channel_id?: number
          org_id?: string
          permission_key?: string
        }
        Returns: boolean
      }
      convert_bytes_to_gb: { Args: { bytes_value: number }; Returns: number }
      convert_bytes_to_mb: { Args: { bytes_value: number }; Returns: number }
      convert_gb_to_bytes: { Args: { gb: number }; Returns: number }
      convert_mb_to_bytes: { Args: { gb: number }; Returns: number }
      convert_number_to_percent: {
        Args: { max_val: number; val: number }
        Returns: number
      }
      count_active_users: { Args: { app_ids: string[] }; Returns: number }
      count_all_need_upgrade: { Args: never; Returns: number }
      count_all_onboarded: { Args: never; Returns: number }
      count_all_plans_v2: {
        Args: never
        Returns: {
          count: number
          plan_name: string
        }[]
      }
      count_non_compliant_bundles: {
        Args: { org_id: string; required_key?: string }
        Returns: {
          non_encrypted_count: number
          total_non_compliant: number
          wrong_key_count: number
        }[]
      }
      current_app_preview_apikey_rbac_id: {
        Args: { p_app_id: string; p_owner_org: string }
        Returns: string
      }
      current_app_preview_binding_id: {
        Args: { p_app_id: string; p_owner_org: string }
        Returns: string
      }
      current_request_role: { Args: never; Returns: string }
      current_user_member_org_ids: { Args: never; Returns: string[] }
      delete_accounts_marked_for_deletion: {
        Args: never
        Returns: {
          deleted_count: number
          deleted_user_ids: string[]
        }[]
      }
      delete_group_with_bindings: {
        Args: { group_id: string }
        Returns: undefined
      }
      delete_http_response: { Args: { request_id: number }; Returns: undefined }
      delete_non_compliant_bundles: {
        Args: { org_id: string; required_key?: string }
        Returns: number
      }
      delete_old_deleted_apps: { Args: never; Returns: undefined }
      delete_old_deleted_versions: { Args: never; Returns: undefined }
      delete_org_member_role: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: string
      }
      delete_user: { Args: never; Returns: undefined }
      exist_app: { Args: { appid: string }; Returns: boolean }
      exist_app_v2: { Args: { appid: string }; Returns: boolean }
      exist_app_versions:
        | { Args: { appid: string; name_version: string }; Returns: boolean }
        | {
            Args: { apikey: string; appid: string; name_version: string }
            Returns: boolean
          }
      expire_usage_credits: { Args: never; Returns: number }
      find_apikey_by_value: {
        Args: { key_value: string }
        Returns: {
          created_at: string | null
          expires_at: string | null
          id: number
          key: string | null
          key_hash: string | null
          name: string
          rbac_id: string
          updated_at: string | null
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "apikeys"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      find_best_plan_v3: {
        Args: {
          bandwidth: number
          build_time_unit?: number
          mau: number
          storage: number
        }
        Returns: string
      }
      find_fit_plan_v3: {
        Args: {
          bandwidth: number
          build_time_unit?: number
          mau: number
          storage: number
        }
        Returns: {
          name: string
        }[]
      }
      get_accessible_apps_for_apikey_v2: {
        Args: { apikey?: string }
        Returns: {
          allow_device_custom_id: boolean
          allow_preview: boolean
          android_store_url: string | null
          app_id: string
          block_provider_infra_requests: boolean
          build_timeout_seconds: number
          build_timeout_updated_at: string
          channel_device_count: number
          created_at: string | null
          created_from_onboarding: boolean
          default_upload_channel: string
          existing_app: boolean
          expose_metadata: boolean
          icon_url: string
          id: string | null
          ios_store_url: string | null
          last_version: string | null
          manifest_bundle_count: number
          name: string | null
          need_onboarding: boolean
          onboarding_completed_at: string | null
          owner_org: string
          retention: number
          rollout_channel_count: number
          rollout_paused_version_names: string[]
          stats_refresh_requested_at: string | null
          stats_updated_at: string | null
          transfer_history: Json[] | null
          updated_at: string | null
          user_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "apps"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_account_removal_date: { Args: never; Returns: string }
      get_apikey: { Args: never; Returns: string }
      get_apikey_header: { Args: never; Returns: string }
      get_app_access_rbac: {
        Args: { p_app_id: string }
        Returns: {
          expires_at: string
          granted_at: string
          granted_by: string
          id: string
          is_direct: boolean
          principal_id: string
          principal_name: string
          principal_type: string
          reason: string
          role_description: string
          role_id: string
          role_name: string
        }[]
      }
      get_app_metrics:
        | {
            Args: { org_id: string }
            Returns: {
              app_id: string
              bandwidth: number
              build_time_unit: number
              date: string
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
        | {
            Args: { end_date: string; org_id: string; start_date: string }
            Returns: {
              app_id: string
              bandwidth: number
              build_time_unit: number
              date: string
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
        | {
            Args: {
              p_app_id: string
              p_end_date: string
              p_org_id: string
              p_start_date: string
            }
            Returns: {
              app_id: string
              bandwidth: number
              build_time_unit: number
              date: string
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
      get_app_versions: {
        Args: { apikey: string; appid: string; name_version: string }
        Returns: number
      }
      get_channel_current_bundle_rbac: {
        Args: { p_app_id: string; p_channel_id: number }
        Returns: {
          bundle_name: string
        }[]
      }
      get_current_plan_max_org: {
        Args: { orgid: string }
        Returns: {
          bandwidth: number
          build_time_unit: number
          mau: number
          native_build_concurrency: number
          storage: number
        }[]
      }
      get_current_plan_name_org: { Args: { orgid: string }; Returns: string }
      get_customer_counts: {
        Args: never
        Returns: {
          monthly: number
          total: number
          yearly: number
        }[]
      }
      get_cycle_info_org: {
        Args: { orgid: string }
        Returns: {
          subscription_anchor_end: string
          subscription_anchor_start: string
        }[]
      }
      get_db_url: { Args: never; Returns: string }
      get_global_metrics:
        | {
            Args: { org_id: string }
            Returns: {
              bandwidth: number
              date: string
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
        | {
            Args: { end_date: string; org_id: string; start_date: string }
            Returns: {
              bandwidth: number
              date: string
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
      get_invite_by_magic_lookup: {
        Args: { lookup: string }
        Returns: {
          org_logo: string
          org_name: string
          role: string
        }[]
      }
      get_mfa_email_otp_enforced_at: { Args: never; Returns: string }
      get_next_cron_time: {
        Args: { p_schedule: string; p_timestamp: string }
        Returns: string
      }
      get_next_cron_value: {
        Args: { current_val: number; max_val: number; pattern: string }
        Returns: number
      }
      get_next_stats_update_date: { Args: { org: string }; Returns: string }
      get_org_apikeys: {
        Args: { p_org_id: string }
        Returns: {
          created_at: string
          expires_at: string
          id: number
          name: string
          owner_email: string
          rbac_id: string
          user_id: string
        }[]
      }
      get_org_apps_with_last_upload: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_org_id: string
          p_search?: string
          p_sort_by?: string
          p_sort_desc?: boolean
        }
        Returns: {
          allow_device_custom_id: boolean
          allow_preview: boolean
          android_store_url: string
          app_id: string
          block_provider_infra_requests: boolean
          build_timeout_seconds: number
          build_timeout_updated_at: string
          channel_device_count: number
          created_at: string
          default_upload_channel: string
          existing_app: boolean
          expose_metadata: boolean
          icon_url: string
          id: string
          ios_store_url: string
          last_upload_at: string
          last_version: string
          manifest_bundle_count: number
          name: string
          need_onboarding: boolean
          owner_org: string
          retention: number
          stats_refresh_requested_at: string
          stats_updated_at: string
          total_count: number
          transfer_history: Json[]
          updated_at: string
          user_id: string
        }[]
      }
      get_org_build_time_unit: {
        Args: { p_end_date: string; p_org_id: string; p_start_date: string }
        Returns: {
          total_build_time_unit: number
          total_builds: number
        }[]
      }
      get_org_members:
        | {
            Args: { guild_id: string }
            Returns: {
              aid: number
              email: string
              image_url: string
              is_tmp: boolean
              role: string
              uid: string
            }[]
          }
        | {
            Args: { guild_id: string; user_id: string }
            Returns: {
              aid: number
              email: string
              image_url: string
              is_tmp: boolean
              role: string
              uid: string
            }[]
          }
      get_org_members_rbac: {
        Args: { p_org_id: string }
        Returns: {
          binding_id: string
          email: string
          granted_at: string
          image_url: string
          is_invite: boolean
          is_tmp: boolean
          org_user_id: number
          role_id: string
          role_name: string
          user_id: string
        }[]
      }
      get_org_perm_for_apikey: {
        Args: { apikey: string; app_id: string }
        Returns: string
      }
      get_org_perm_for_apikey_v2: {
        Args: { apikey: string; app_id: string }
        Returns: string
      }
      get_org_user_access_rbac: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: {
          app_id: string
          channel_id: string
          expires_at: string
          granted_at: string
          granted_by: string
          group_name: string
          id: string
          is_direct: boolean
          org_id: string
          principal_id: string
          principal_name: string
          principal_type: string
          reason: string
          role_description: string
          role_id: string
          role_name: string
          scope_type: string
          user_email: string
        }[]
      }
      get_organization_cli_warnings: {
        Args: { cli_version: string; orgid: string }
        Returns: Json[]
      }
      get_orgs_v6: {
        Args: never
        Returns: {
          app_count: number
          can_use_more: boolean
          created_by: string
          gid: string
          is_canceled: boolean
          is_yearly: boolean
          logo: string
          management_email: string
          name: string
          paying: boolean
          role: string
          subscription_end: string
          subscription_start: string
          trial_left: number
        }[]
      }
      get_orgs_v7:
        | {
            Args: never
            Returns: {
              "2fa_has_access": boolean
              app_count: number
              can_use_more: boolean
              created_at: string
              created_by: string
              credit_available: number
              credit_next_expiration: string
              credit_total: number
              enforce_encrypted_bundles: boolean
              enforce_hashed_api_keys: boolean
              enforcing_2fa: boolean
              gid: string
              is_canceled: boolean
              is_invite: boolean
              is_yearly: boolean
              logo: string
              management_email: string
              max_apikey_expiration_days: number
              name: string
              next_stats_update_at: string
              password_has_access: boolean
              password_policy_config: Json
              paying: boolean
              require_apikey_expiration: boolean
              required_encryption_key: string
              role: string
              stats_refresh_requested_at: string
              stats_updated_at: string
              subscription_end: string
              subscription_start: string
              trial_left: number
              website: string
            }[]
          }
        | {
            Args: { userid: string }
            Returns: {
              "2fa_has_access": boolean
              app_count: number
              can_use_more: boolean
              created_at: string
              created_by: string
              credit_available: number
              credit_next_expiration: string
              credit_total: number
              enforce_encrypted_bundles: boolean
              enforce_hashed_api_keys: boolean
              enforcing_2fa: boolean
              gid: string
              is_canceled: boolean
              is_invite: boolean
              is_yearly: boolean
              logo: string
              management_email: string
              max_apikey_expiration_days: number
              name: string
              next_stats_update_at: string
              password_has_access: boolean
              password_policy_config: Json
              paying: boolean
              require_apikey_expiration: boolean
              required_encryption_key: string
              role: string
              stats_refresh_requested_at: string
              stats_updated_at: string
              subscription_end: string
              subscription_start: string
              trial_left: number
              website: string
            }[]
          }
      get_owner_org_by_app_id_internal: {
        Args: { p_app_id: string }
        Returns: string
      }
      get_password_policy_hash: {
        Args: { policy_config: Json }
        Returns: string
      }
      get_plan_usage_and_fit: {
        Args: { orgid: string }
        Returns: {
          bandwidth_percent: number
          build_time_percent: number
          is_good_plan: boolean
          mau_percent: number
          storage_percent: number
          total_percent: number
        }[]
      }
      get_plan_usage_and_fit_uncached: {
        Args: { orgid: string }
        Returns: {
          bandwidth_percent: number
          build_time_percent: number
          is_good_plan: boolean
          mau_percent: number
          storage_percent: number
          total_percent: number
        }[]
      }
      get_plan_usage_percent_detailed:
        | {
            Args: { orgid: string }
            Returns: {
              bandwidth_percent: number
              build_time_percent: number
              mau_percent: number
              storage_percent: number
              total_percent: number
            }[]
          }
        | {
            Args: { cycle_end: string; cycle_start: string; orgid: string }
            Returns: {
              bandwidth_percent: number
              build_time_percent: number
              mau_percent: number
              storage_percent: number
              total_percent: number
            }[]
          }
      get_sso_enforcement_by_domain: {
        Args: { p_domain: string }
        Returns: {
          enforce_sso: boolean
          org_id: string
        }[]
      }
      get_total_app_storage_size_orgs: {
        Args: { app_id: string; org_id: string }
        Returns: number
      }
      get_total_metrics:
        | {
            Args: never
            Returns: {
              bandwidth: number
              build_time_unit: number
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
        | {
            Args: { org_id: string }
            Returns: {
              bandwidth: number
              build_time_unit: number
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
        | {
            Args: { end_date: string; org_id: string; start_date: string }
            Returns: {
              bandwidth: number
              build_time_unit: number
              fail: number
              get: number
              install: number
              mau: number
              storage: number
              uninstall: number
            }[]
          }
      get_total_storage_size_org: { Args: { org_id: string }; Returns: number }
      get_update_stats: {
        Args: never
        Returns: {
          app_id: string
          failed: number
          get: number
          healthy: boolean
          install: number
          success_rate: number
        }[]
      }
      get_user_id:
        | { Args: { apikey: string }; Returns: string }
        | { Args: { apikey: string; app_id: string }; Returns: string }
      get_user_main_org_id: { Args: { user_id: string }; Returns: string }
      get_user_main_org_id_by_app_id: {
        Args: { app_id: string }
        Returns: string
      }
      get_user_org_ids: {
        Args: never
        Returns: {
          org_id: string
        }[]
      }
      get_versions_with_no_metadata: {
        Args: never
        Returns: {
          app_id: string
          checksum: string | null
          cli_version: string | null
          comment: string | null
          created_at: string | null
          created_by_apikey_rbac_id: string | null
          deleted: boolean
          deleted_at: string | null
          external_url: string | null
          id: number
          key_id: string | null
          link: string | null
          manifest:
            | Database["public"]["CompositeTypes"]["manifest_entry"][]
            | null
          manifest_count: number
          min_update_version: string | null
          name: string
          native_packages: Json[] | null
          owner_org: string
          r2_path: string | null
          session_key: string | null
          storage_provider: string
          updated_at: string | null
          user_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "app_versions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_weekly_stats: {
        Args: { app_id: string }
        Returns: {
          all_updates: number
          failed_updates: number
          open_app: number
        }[]
      }
      group_max_role_priority: { Args: { p_group_id: string }; Returns: number }
      has_2fa_enabled:
        | { Args: never; Returns: boolean }
        | { Args: { user_id: string }; Returns: boolean }
      has_effective_active_org_super_admin: {
        Args: { p_excluded_user_id?: string; p_org_id: string }
        Returns: boolean
      }
      has_effective_non_expiring_org_super_admin_after_removal: {
        Args: {
          p_excluded_binding_id?: string
          p_excluded_group_id?: string
          p_excluded_group_member_group_id?: string
          p_excluded_group_member_user_id?: string
          p_excluded_user_id?: string
          p_org_id: string
        }
        Returns: boolean
      }
      has_seeded_demo_data: { Args: { p_app_id: string }; Returns: boolean }
      internal_request_db_user_names: { Args: never; Returns: string[] }
      internal_request_role_names: { Args: never; Returns: string[] }
      invite_user_to_org_rbac: {
        Args: { email: string; org_id: string; role_name: string }
        Returns: string
      }
      is_account_disabled: { Args: { user_id: string }; Returns: boolean }
      is_active_org_super_admin_binding: {
        Args: {
          p_expires_at: string
          p_org_id: string
          p_principal_type: string
          p_role_id: string
          p_scope_type: string
        }
        Returns: boolean
      }
      is_allowed_action: {
        Args: { apikey: string; appid: string }
        Returns: boolean
      }
      is_allowed_action_org: { Args: { orgid: string }; Returns: boolean }
      is_allowed_action_org_action:
        | {
            Args: {
              actions: Database["public"]["Enums"]["action_type"][]
              orgid: string
            }
            Returns: boolean
          }
        | {
            Args: {
              actions: Database["public"]["Enums"]["action_type"][]
              appid: string
              orgid: string
            }
            Returns: boolean
          }
      is_allowed_capgkey:
        | { Args: { apikey: string; keymode: string[] }; Returns: boolean }
        | {
            Args: { apikey: string; appid: string; keymode: string[] }
            Returns: boolean
          }
      is_apikey_expired: { Args: { key_expires_at: string }; Returns: boolean }
      is_app_owner:
        | { Args: { apikey: string; appid: string }; Returns: boolean }
        | { Args: { appid: string }; Returns: boolean }
        | { Args: { appid: string; userid: string }; Returns: boolean }
      is_bandwidth_exceeded_by_org: {
        Args: { org_id: string }
        Returns: boolean
      }
      is_build_time_exceeded_by_org: {
        Args: { org_id: string }
        Returns: boolean
      }
      is_bundle_encrypted: { Args: { session_key: string }; Returns: boolean }
      is_canceled_org: { Args: { orgid: string }; Returns: boolean }
      is_current_user_group_member: {
        Args: { p_group_id: string }
        Returns: boolean
      }
      is_effective_active_org_super_admin_user: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: boolean
      }
      is_good_plan_v5_org: { Args: { orgid: string }; Returns: boolean }
      is_internal_request_role: {
        Args: { caller_role: string }
        Returns: boolean
      }
      is_mau_exceeded_by_org: { Args: { org_id: string }; Returns: boolean }
      is_member_of_org: {
        Args: { org_id: string; user_id: string }
        Returns: boolean
      }
      is_nested_self_org_departure_cleanup: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: boolean
      }
      is_not_deleted: { Args: { email_check: string }; Returns: boolean }
      is_numeric: { Args: { "": string }; Returns: boolean }
      is_onboarded_org: { Args: { orgid: string }; Returns: boolean }
      is_onboarding_needed_org: { Args: { orgid: string }; Returns: boolean }
      is_org_delete_cascade: { Args: { p_org_id: string }; Returns: boolean }
      is_org_yearly: { Args: { orgid: string }; Returns: boolean }
      is_paying_and_good_plan_org: { Args: { orgid: string }; Returns: boolean }
      is_paying_and_good_plan_org_action:
        | {
            Args: {
              actions: Database["public"]["Enums"]["action_type"][]
              orgid: string
            }
            Returns: boolean
          }
        | {
            Args: {
              actions: Database["public"]["Enums"]["action_type"][]
              appid: string
              orgid: string
            }
            Returns: boolean
          }
      is_paying_org: { Args: { orgid: string }; Returns: boolean }
      is_platform_admin:
        | { Args: never; Returns: boolean }
        | { Args: { userid: string }; Returns: boolean }
      is_rbac_enabled_globally: { Args: never; Returns: boolean }
      is_recent_email_otp_verified: {
        Args: { user_id: string }
        Returns: boolean
      }
      is_storage_exceeded_by_org: { Args: { org_id: string }; Returns: boolean }
      is_trial_org: { Args: { orgid: string }; Returns: number }
      is_user_app_admin: {
        Args: { p_app_id: string; p_user_id: string }
        Returns: boolean
      }
      is_user_org_admin: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: boolean
      }
      lock_channel_bundle_lifecycle: {
        Args: { p_rollout_version_id: number; p_version_id: number }
        Returns: undefined
      }
      lock_rbac_orgs: {
        Args: { p_first_org_id: string; p_second_org_id?: string }
        Returns: undefined
      }
      mark_app_stats_refreshed: { Args: { p_app_id: string }; Returns: string }
      mass_edit_queue_messages_cf_ids: {
        Args: {
          updates: Database["public"]["CompositeTypes"]["message_update"][]
        }
        Returns: undefined
      }
      null_migrated_app_version_manifests: {
        Args: { batch_size?: number; max_batches?: number }
        Returns: undefined
      }
      one_month_ahead: { Args: never; Returns: string }
      org_member_readable_org_ids: { Args: never; Returns: string[] }
      orgs_admin_org_ids: { Args: never; Returns: string[] }
      orgs_readable_org_ids: { Args: never; Returns: string[] }
      parse_cron_field: {
        Args: { current_val: number; field: string; max_val: number }
        Returns: number
      }
      parse_step_pattern: { Args: { pattern: string }; Returns: number }
      pg_log: { Args: { decision: string; input?: Json }; Returns: undefined }
      principal_can_manage_group_rank: {
        Args: {
          p_group_id: string
          p_principal_id: string
          p_principal_type: string
        }
        Returns: boolean
      }
      principal_max_role_priority: {
        Args: {
          p_org_id: string
          p_principal_id: string
          p_principal_type: string
        }
        Returns: number
      }
      process_admin_stats: { Args: never; Returns: undefined }
      process_all_cron_tasks: { Args: never; Returns: undefined }
      process_billing_period_stats_email: { Args: never; Returns: undefined }
      process_channel_device_counts_queue: {
        Args: { batch_size?: number }
        Returns: number
      }
      process_cron_stats_jobs: { Args: never; Returns: undefined }
      process_cron_sync_sub_jobs: { Args: never; Returns: undefined }
      process_daily_fail_ratio_email: { Args: never; Returns: undefined }
      process_deploy_install_stats_email: { Args: never; Returns: undefined }
      process_failed_uploads: { Args: never; Returns: undefined }
      process_free_trial_expired: { Args: never; Returns: undefined }
      process_function_queue:
        | {
            Args: { batch_size?: number; queue_name: string }
            Returns: undefined
          }
        | {
            Args: { batch_size?: number; queue_names: string[] }
            Returns: undefined
          }
      process_queue_with_healthcheck: {
        Args: {
          batch_size: number
          healthcheck_url: string
          queue_names: string[]
        }
        Returns: undefined
      }
      process_stats_email_monthly: { Args: never; Returns: undefined }
      process_stats_email_weekly: { Args: never; Returns: undefined }
      process_subscribed_orgs: { Args: never; Returns: undefined }
      queue_cron_stat_app_for_app: {
        Args: { p_app_id: string; p_org_id?: string }
        Returns: undefined
      }
      queue_cron_stat_org_for_org: {
        Args: { customer_id: string; org_id: string }
        Returns: undefined
      }
      rbac_check_permission: {
        Args: {
          p_app_id?: string
          p_channel_id?: number
          p_org_id?: string
          p_permission_key: string
        }
        Returns: boolean
      }
      rbac_check_permission_direct: {
        Args: {
          p_apikey?: string
          p_app_id: string
          p_channel_id: number
          p_org_id: string
          p_permission_key: string
          p_user_id: string
        }
        Returns: boolean
      }
      rbac_check_permission_direct_no_password_policy: {
        Args: {
          p_apikey?: string
          p_app_id: string
          p_channel_id: number
          p_org_id: string
          p_permission_key: string
          p_user_id: string
        }
        Returns: boolean
      }
      rbac_check_permission_no_password_policy: {
        Args: {
          p_app_id?: string
          p_channel_id?: number
          p_org_id?: string
          p_permission_key: string
        }
        Returns: boolean
      }
      rbac_check_permission_request: {
        Args: {
          p_app_id?: string
          p_channel_id?: number
          p_org_id?: string
          p_permission_key: string
        }
        Returns: boolean
      }
      rbac_denied_channel_ids_for_permission: {
        Args: { p_permission_key: string }
        Returns: number[]
      }
      rbac_direct_channel_ids_for_permission: {
        Args: { p_permission_key: string }
        Returns: number[]
      }
      rbac_has_permission: {
        Args: {
          p_app_id: string
          p_channel_id: number
          p_org_id: string
          p_permission_key: string
          p_principal_id: string
          p_principal_type: string
        }
        Returns: boolean
      }
      rbac_org_ids_for_permission: {
        Args: { p_permission_key: string }
        Returns: string[]
      }
      rbac_perm_app_build_native: { Args: never; Returns: string }
      rbac_perm_app_create_channel: { Args: never; Returns: string }
      rbac_perm_app_delete: { Args: never; Returns: string }
      rbac_perm_app_manage_devices: { Args: never; Returns: string }
      rbac_perm_app_read: { Args: never; Returns: string }
      rbac_perm_app_read_audit: { Args: never; Returns: string }
      rbac_perm_app_read_bundles: { Args: never; Returns: string }
      rbac_perm_app_read_channels: { Args: never; Returns: string }
      rbac_perm_app_read_devices: { Args: never; Returns: string }
      rbac_perm_app_read_logs: { Args: never; Returns: string }
      rbac_perm_app_transfer: { Args: never; Returns: string }
      rbac_perm_app_update_settings: { Args: never; Returns: string }
      rbac_perm_app_update_user_roles: { Args: never; Returns: string }
      rbac_perm_app_upload_bundle: { Args: never; Returns: string }
      rbac_perm_bundle_delete: { Args: never; Returns: string }
      rbac_perm_bundle_read: { Args: never; Returns: string }
      rbac_perm_bundle_update: { Args: never; Returns: string }
      rbac_perm_channel_delete: { Args: never; Returns: string }
      rbac_perm_channel_manage_forced_devices: { Args: never; Returns: string }
      rbac_perm_channel_promote_bundle: { Args: never; Returns: string }
      rbac_perm_channel_read: { Args: never; Returns: string }
      rbac_perm_channel_read_audit: { Args: never; Returns: string }
      rbac_perm_channel_read_forced_devices: { Args: never; Returns: string }
      rbac_perm_channel_read_history: { Args: never; Returns: string }
      rbac_perm_channel_rollback_bundle: { Args: never; Returns: string }
      rbac_perm_channel_update_settings: { Args: never; Returns: string }
      rbac_perm_org_create: { Args: never; Returns: string }
      rbac_perm_org_create_app: { Args: never; Returns: string }
      rbac_perm_org_delete: { Args: never; Returns: string }
      rbac_perm_org_invite_user: { Args: never; Returns: string }
      rbac_perm_org_manage_apikeys: { Args: never; Returns: string }
      rbac_perm_org_read: { Args: never; Returns: string }
      rbac_perm_org_read_audit: { Args: never; Returns: string }
      rbac_perm_org_read_billing: { Args: never; Returns: string }
      rbac_perm_org_read_billing_audit: { Args: never; Returns: string }
      rbac_perm_org_read_invoices: { Args: never; Returns: string }
      rbac_perm_org_read_members: { Args: never; Returns: string }
      rbac_perm_org_update_billing: { Args: never; Returns: string }
      rbac_perm_org_update_settings: { Args: never; Returns: string }
      rbac_perm_org_update_user_roles: { Args: never; Returns: string }
      rbac_perm_platform_db_break_glass: { Args: never; Returns: string }
      rbac_perm_platform_delete_orphan_users: { Args: never; Returns: string }
      rbac_perm_platform_impersonate_user: { Args: never; Returns: string }
      rbac_perm_platform_manage_apps_any: { Args: never; Returns: string }
      rbac_perm_platform_manage_channels_any: { Args: never; Returns: string }
      rbac_perm_platform_manage_orgs_any: { Args: never; Returns: string }
      rbac_perm_platform_read_all_audit: { Args: never; Returns: string }
      rbac_perm_platform_run_maintenance_jobs: { Args: never; Returns: string }
      rbac_principal_apikey: { Args: never; Returns: string }
      rbac_principal_group: { Args: never; Returns: string }
      rbac_principal_user: { Args: never; Returns: string }
      rbac_role_apikey_manager: { Args: never; Returns: string }
      rbac_role_apikey_org_reader: { Args: never; Returns: string }
      rbac_role_app_admin: { Args: never; Returns: string }
      rbac_role_app_developer: { Args: never; Returns: string }
      rbac_role_app_reader: { Args: never; Returns: string }
      rbac_role_app_uploader: { Args: never; Returns: string }
      rbac_role_bundle_admin: { Args: never; Returns: string }
      rbac_role_bundle_reader: { Args: never; Returns: string }
      rbac_role_channel_admin: { Args: never; Returns: string }
      rbac_role_channel_developer: { Args: never; Returns: string }
      rbac_role_channel_reader: { Args: never; Returns: string }
      rbac_role_channel_uploader: { Args: never; Returns: string }
      rbac_role_org_admin: { Args: never; Returns: string }
      rbac_role_org_billing_admin: { Args: never; Returns: string }
      rbac_role_org_member: { Args: never; Returns: string }
      rbac_role_org_super_admin: { Args: never; Returns: string }
      rbac_role_platform_super_admin: { Args: never; Returns: string }
      rbac_scope_app: { Args: never; Returns: string }
      rbac_scope_bundle: { Args: never; Returns: string }
      rbac_scope_channel: { Args: never; Returns: string }
      rbac_scope_org: { Args: never; Returns: string }
      rbac_scope_platform: { Args: never; Returns: string }
      read_bandwidth_usage: {
        Args: { p_app_id: string; p_period_end: string; p_period_start: string }
        Returns: {
          app_id: string
          bandwidth: number
          date: string
        }[]
      }
      read_device_usage: {
        Args: { p_app_id: string; p_period_end: string; p_period_start: string }
        Returns: {
          app_id: string
          date: string
          mau: number
        }[]
      }
      read_native_version_usage: {
        Args: { p_app_id: string; p_period_end: string; p_period_start: string }
        Returns: {
          date: string
          devices: number
          platform: string
          version_build: string
        }[]
      }
      read_storage_usage: {
        Args: { p_app_id: string; p_period_end: string; p_period_start: string }
        Returns: {
          app_id: string
          date: string
          storage: number
        }[]
      }
      read_version_usage: {
        Args: {
          p_app_id: string
          p_channel_id?: number
          p_channel_name?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          app_id: string
          date: string
          fail: number
          get: number
          install: number
          uninstall: number
          version_name: string
        }[]
      }
      readable_app_version_ids: { Args: never; Returns: number[] }
      readable_group_ids: { Args: never; Returns: string[] }
      readable_org_customer_ids: { Args: never; Returns: string[] }
      record_build_time: {
        Args: {
          p_app_id: string
          p_build_id: string
          p_build_time_unit: number
          p_org_id: string
          p_platform: string
          p_user_id: string
        }
        Returns: string
      }
      record_email_otp_verified: {
        Args: { p_user_id: string }
        Returns: string
      }
      refresh_app_rollout_channel_count_for_app: {
        Args: { p_app_id: string }
        Returns: undefined
      }
      refresh_app_rollups_after_demo_reset: {
        Args: { p_app_id: string; p_app_uuid: string; p_owner_org: string }
        Returns: undefined
      }
      refresh_orgs_has_usage_credits: { Args: never; Returns: undefined }
      regenerate_hashed_apikey: {
        Args: { p_apikey_id: number }
        Returns: {
          created_at: string | null
          expires_at: string | null
          id: number
          key: string | null
          key_hash: string | null
          name: string
          rbac_id: string
          updated_at: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "apikeys"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      regenerate_hashed_apikey_for_user: {
        Args: { p_apikey_id: number; p_user_id: string }
        Returns: {
          created_at: string | null
          expires_at: string | null
          id: number
          key: string | null
          key_hash: string | null
          name: string
          rbac_id: string
          updated_at: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "apikeys"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reject_access_due_to_2fa: {
        Args: { org_id: string; user_id: string }
        Returns: boolean
      }
      reject_access_due_to_2fa_for_app: {
        Args: { app_id: string }
        Returns: boolean
      }
      reject_access_due_to_2fa_for_org: {
        Args: { org_id: string }
        Returns: boolean
      }
      reject_access_due_to_password_policy: {
        Args: { org_id: string; user_id: string }
        Returns: boolean
      }
      remove_old_jobs: { Args: never; Returns: undefined }
      request_actor_user_id: { Args: never; Returns: string }
      request_app_chart_refresh: {
        Args: { app_id: string }
        Returns: {
          queued_app_ids: string[]
          queued_count: number
          requested_at: string
          skipped_count: number
        }[]
      }
      request_has_app_read_access: {
        Args: { appid: string; orgid: string }
        Returns: boolean
      }
      request_has_org_read_access: { Args: { orgid: string }; Returns: boolean }
      request_org_chart_refresh: {
        Args: { org_id: string }
        Returns: {
          queued_app_ids: string[]
          queued_count: number
          requested_at: string
          skipped_count: number
        }[]
      }
      request_principal_max_role_priority: {
        Args: { p_org_id: string }
        Returns: number
      }
      rescind_invitation: {
        Args: { email: string; org_id: string }
        Returns: string
      }
      reset_onboarding_demo_app_data: {
        Args: { p_app_uuid: string }
        Returns: undefined
      }
      restore_deleted_account: { Args: never; Returns: undefined }
      role_bindings_readable_ids: { Args: never; Returns: string[] }
      seed_get_app_metrics_caches: {
        Args: { p_end_date: string; p_org_id: string; p_start_date: string }
        Returns: {
          cached_at: string
          end_date: string
          id: number
          org_id: string
          response: Json
          start_date: string
        }
        SetofOptions: {
          from: "*"
          to: "app_metrics_cache"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      seed_org_metrics_cache: {
        Args: { p_end_date: string; p_org_id: string; p_start_date: string }
        Returns: {
          bandwidth: number
          build_time_unit: number
          cached_at: string
          end_date: string
          fail: number
          get: number
          install: number
          mau: number
          org_id: string
          start_date: string
          storage: number
          uninstall: number
        }
        SetofOptions: {
          from: "*"
          to: "org_metrics_cache"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_build_time_exceeded_by_org: {
        Args: { disabled: boolean; org_id: string }
        Returns: undefined
      }
      strip_html: { Args: { input: string }; Returns: string }
      sweep_deleted_version_manifests: {
        Args: { p_batch_size?: number }
        Returns: number
      }
      top_up_usage_credits: {
        Args: {
          p_amount: number
          p_expires_at?: string
          p_notes?: string
          p_org_id: string
          p_source?: string
          p_source_ref?: Json
        }
        Returns: {
          available_credits: number
          grant_id: string
          next_expiration: string
          total_credits: number
          transaction_id: number
        }[]
      }
      total_bundle_storage_bytes: { Args: never; Returns: number }
      track_onboarding_demo_data: {
        Args: {
          p_app_id: string
          p_owner_org: string
          p_relation_name: string
          p_row_keys: string[]
          p_seed_id: string
        }
        Returns: undefined
      }
      transfer_app: {
        Args: { p_app_id: string; p_new_org_id: string }
        Returns: undefined
      }
      update_app_versions_retention: { Args: never; Returns: undefined }
      update_org_invite_role_rbac: {
        Args: { p_new_role_name: string; p_org_id: string; p_user_id: string }
        Returns: string
      }
      update_org_member_role: {
        Args: { p_new_role_name: string; p_org_id: string; p_user_id: string }
        Returns: string
      }
      update_tmp_invite_role_rbac: {
        Args: { p_email: string; p_new_role_name: string; p_org_id: string }
        Returns: string
      }
      upsert_version_meta: {
        Args: { p_app_id: string; p_size: number; p_version_id: number }
        Returns: boolean
      }
      usage_credit_readable_org_ids: { Args: never; Returns: string[] }
      user_has_app_update_user_roles: {
        Args: { p_app_id: string; p_user_id: string }
        Returns: boolean
      }
      user_has_role_in_app: {
        Args: { p_app_id: string; p_user_id: string }
        Returns: boolean
      }
      user_meets_password_policy: {
        Args: { org_id: string; user_id: string }
        Returns: boolean
      }
      verify_api_key_hash: {
        Args: { plain_key: string; stored_hash: string }
        Returns: boolean
      }
      verify_mfa: { Args: never; Returns: boolean }
    }
    Enums: {
      action_type: "mau" | "storage" | "bandwidth" | "build_time"
      credit_metric_type: "mau" | "bandwidth" | "storage" | "build_time"
      credit_transaction_type:
        | "grant"
        | "purchase"
        | "manual_grant"
        | "deduction"
        | "expiry"
        | "refund"
      cron_task_type: "function" | "queue" | "function_queue"
      disable_update: "major" | "minor" | "patch" | "version_number" | "none"
      platform_os: "ios" | "android" | "electron"
      stats_action:
        | "delete"
        | "reset"
        | "set"
        | "get"
        | "set_fail"
        | "update_fail"
        | "download_fail"
        | "windows_path_fail"
        | "canonical_path_fail"
        | "directory_path_fail"
        | "unzip_fail"
        | "low_mem_fail"
        | "download_10"
        | "download_20"
        | "download_30"
        | "download_40"
        | "download_50"
        | "download_60"
        | "download_70"
        | "download_80"
        | "download_90"
        | "download_complete"
        | "decrypt_fail"
        | "app_moved_to_foreground"
        | "app_moved_to_background"
        | "uninstall"
        | "needPlanUpgrade"
        | "missingBundle"
        | "noNew"
        | "disablePlatformIos"
        | "disablePlatformAndroid"
        | "disableAutoUpdateToMajor"
        | "cannotUpdateViaPrivateChannel"
        | "disableAutoUpdateToMinor"
        | "disableAutoUpdateToPatch"
        | "channelMisconfigured"
        | "disableAutoUpdateMetadata"
        | "disableAutoUpdateUnderNative"
        | "disableDevBuild"
        | "disableEmulator"
        | "cannotGetBundle"
        | "checksum_fail"
        | "NoChannelOrOverride"
        | "setChannel"
        | "getChannel"
        | "rateLimited"
        | "disableAutoUpdate"
        | "keyMismatch"
        | "ping"
        | "InvalidIp"
        | "blocked_by_server_url"
        | "download_manifest_start"
        | "download_manifest_complete"
        | "download_zip_start"
        | "download_zip_complete"
        | "download_manifest_file_fail"
        | "download_manifest_checksum_fail"
        | "download_manifest_brotli_fail"
        | "backend_refusal"
        | "download_0"
        | "disableProdBuild"
        | "disableDevice"
        | "disablePlatformElectron"
        | "customIdBlocked"
        | "app_crash"
        | "app_crash_native"
        | "app_anr"
        | "app_killed_low_memory"
        | "app_killed_excessive_resource_usage"
        | "app_initialization_failure"
        | "app_memory_warning"
        | "webview_javascript_error"
        | "webview_unhandled_rejection"
        | "webview_resource_error"
        | "webview_security_policy_violation"
        | "webview_unclean_restart"
        | "webview_render_process_gone"
        | "webview_content_process_terminated"
        | "os_version_changed"
        | "native_app_version_changed"
        | "finish_download_fail"
        | "checksum_required"
        | "manifest_path_fail"
        | "rate_limit_reached"
        | "set_next"
        | "insufficient_disk_space"
        | "app_launch_start"
        | "app_launch_ready"
        | "app_launch_timeout"
        | "webview_dom_content_loaded"
        | "webview_page_loaded"
      stripe_status:
        | "created"
        | "succeeded"
        | "updated"
        | "failed"
        | "deleted"
        | "canceled"
      user_role: "read" | "upload" | "write" | "admin"
      version_action: "get" | "fail" | "install" | "uninstall"
    }
    CompositeTypes: {
      manifest_entry: {
        file_name: string | null
        s3_path: string | null
        file_hash: string | null
      }
      message_update: {
        msg_id: number | null
        cf_id: string | null
        queue: string | null
      }
      orgs_table: {
        id: string | null
        created_by: string | null
        created_at: string | null
        updated_at: string | null
        logo: string | null
        name: string | null
      }
      owned_orgs: {
        id: string | null
        created_by: string | null
        logo: string | null
        name: string | null
        role: string | null
      }
      stats_table: {
        mau: number | null
        bandwidth: number | null
        storage: number | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      action_type: ["mau", "storage", "bandwidth", "build_time"],
      credit_metric_type: ["mau", "bandwidth", "storage", "build_time"],
      credit_transaction_type: [
        "grant",
        "purchase",
        "manual_grant",
        "deduction",
        "expiry",
        "refund",
      ],
      cron_task_type: ["function", "queue", "function_queue"],
      disable_update: ["major", "minor", "patch", "version_number", "none"],
      platform_os: ["ios", "android", "electron"],
      stats_action: [
        "delete",
        "reset",
        "set",
        "get",
        "set_fail",
        "update_fail",
        "download_fail",
        "windows_path_fail",
        "canonical_path_fail",
        "directory_path_fail",
        "unzip_fail",
        "low_mem_fail",
        "download_10",
        "download_20",
        "download_30",
        "download_40",
        "download_50",
        "download_60",
        "download_70",
        "download_80",
        "download_90",
        "download_complete",
        "decrypt_fail",
        "app_moved_to_foreground",
        "app_moved_to_background",
        "uninstall",
        "needPlanUpgrade",
        "missingBundle",
        "noNew",
        "disablePlatformIos",
        "disablePlatformAndroid",
        "disableAutoUpdateToMajor",
        "cannotUpdateViaPrivateChannel",
        "disableAutoUpdateToMinor",
        "disableAutoUpdateToPatch",
        "channelMisconfigured",
        "disableAutoUpdateMetadata",
        "disableAutoUpdateUnderNative",
        "disableDevBuild",
        "disableEmulator",
        "cannotGetBundle",
        "checksum_fail",
        "NoChannelOrOverride",
        "setChannel",
        "getChannel",
        "rateLimited",
        "disableAutoUpdate",
        "keyMismatch",
        "ping",
        "InvalidIp",
        "blocked_by_server_url",
        "download_manifest_start",
        "download_manifest_complete",
        "download_zip_start",
        "download_zip_complete",
        "download_manifest_file_fail",
        "download_manifest_checksum_fail",
        "download_manifest_brotli_fail",
        "backend_refusal",
        "download_0",
        "disableProdBuild",
        "disableDevice",
        "disablePlatformElectron",
        "customIdBlocked",
        "app_crash",
        "app_crash_native",
        "app_anr",
        "app_killed_low_memory",
        "app_killed_excessive_resource_usage",
        "app_initialization_failure",
        "app_memory_warning",
        "webview_javascript_error",
        "webview_unhandled_rejection",
        "webview_resource_error",
        "webview_security_policy_violation",
        "webview_unclean_restart",
        "webview_render_process_gone",
        "webview_content_process_terminated",
        "os_version_changed",
        "native_app_version_changed",
        "finish_download_fail",
        "checksum_required",
        "manifest_path_fail",
        "rate_limit_reached",
        "set_next",
        "insufficient_disk_space",
        "app_launch_start",
        "app_launch_ready",
        "app_launch_timeout",
        "webview_dom_content_loaded",
        "webview_page_loaded",
      ],
      stripe_status: [
        "created",
        "succeeded",
        "updated",
        "failed",
        "deleted",
        "canceled",
      ],
      user_role: ["read", "upload", "write", "admin"],
      version_action: ["get", "fail", "install", "uninstall"],
    },
  },
} as const

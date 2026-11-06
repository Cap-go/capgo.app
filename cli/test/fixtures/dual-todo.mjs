export const appId = 'com.example.dual'

export function createDualTodoProgress() {
  return {
    onboarding: {
      setup: {
        todo_list_version: 4,
        ota_todo_list_version: '1',
        builder_todo_list_version: '1',
        paths: ['ota', 'builder'],
        selected_path: 'ota',
        selected_builder_platform: 'ios',
        outcome: 'completed',
        steps: {
          ota: {
            login_cli_mcp: { status: 'done' },
            add_channel: { status: 'done' },
            add_updater: { status: 'pending' },
          },
          builder: {
            ios: {
              start_setup: { status: 'done', at: '2026-01-01T12:00:00Z' },
              choose_destination: { status: 'done', annotation: 'asc_new', annotation_type: 'note' },
            },
            android: {
              start_setup: { status: 'done' },
              prepare_keystore: { status: 'skipped' },
              successful_cloud_build: { status: 'warning', annotation: 'cloud_build_failed', annotation_type: 'warning' },
            },
          },
        },
      },
    },
    hasChannel: true,
    checkErrors: [],
  }
}

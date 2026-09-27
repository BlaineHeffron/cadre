export function businessOsHealthFixture(overrides = {}) {
  return {
    client_id: 'example-client',
    display_name: 'Example Client',
    version: '0.1.0',
    build_sha: 'e53debe0',
    started_at_ms: 1000,
    uptime_ms: 60000,
    now_ms: 61000,
    schema_version: 34,
    status: 'ok',
    pumps: [
      {
        pump: 'accounting_sync',
        in_flight: false,
        last_attempt_ms: 50000,
        last_outcome: 'ok',
        next_allowed_at_ms: 70000,
      },
    ],
    outbox: {
      pending_jobs: 0,
      terminal_jobs: 0,
      last_terminal_error: null,
    },
    errors_1h: {
      window_ms: 3600000,
      failed_receipts: 0,
      conflict_receipts: 0,
      llm_failures: 0,
      llm_errors: [],
    },
    errors_24h: {
      window_ms: 86400000,
      failed_receipts: 0,
      conflict_receipts: 0,
      llm_failures: 0,
      llm_errors: [],
    },
    enabled_slices: ['accounting', 'work_queue', 'instance_diagnostics'],
    visible_slices: ['work_queue', 'instance_diagnostics'],
    ...overrides,
  };
}

export function businessOsRegistryFixture(overrides = {}) {
  return {
    schema_version: 1,
    deployments: [
      {
        deployment_id: 'example-client',
        profile: 'businessos-client',
        environment: 'production',
        public_base_url_ref: 'EXAMPLE_CLIENT_PUBLIC_BASE_URL_REF',
        public_base_url_posture: 'ref_only',
        auth_mode: 'bearer_ref',
        auth_ref: 'EXAMPLE_CLIENT_FLEET_AUTH_REF',
        auth_ref_posture: 'ref_only',
        owner_ref: 'EXAMPLE_CLIENT_OWNER_REF',
        contact_ref: 'EXAMPLE_CLIENT_CONTACT_REF',
        state_namespace_ref: 'EXAMPLE_CLIENT_STATE_NAMESPACE_REF',
        health_route_ref: 'EXAMPLE_CLIENT_HEALTH_ROUTE_REF',
        runtime_status_route_ref: 'EXAMPLE_CLIENT_RUNTIME_STATUS_ROUTE_REF',
        health_contract: 'businessos_diagnostics',
        enabled_modules: ['accounting', 'work_queue', 'instance_diagnostics'],
        polling_interval_seconds: 120,
        expected_provider_write_posture: 'all_disabled_fixture',
        provider_write_policy_ref: 'EXAMPLE_CLIENT_PROVIDER_WRITE_ALL_DISABLED_POLICY_REF',
        live_polling_enabled: false,
        provider_writes_enabled: false,
        session_launch_enabled: false,
        post_dispatch_enabled: false,
        external_network_enabled: false,
        disabled_reasons: ['provider_writes_disabled', 'read_only_monitoring_only'],
      },
    ],
    ...overrides,
  };
}

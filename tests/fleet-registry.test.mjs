import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFleetRegistry, validateFleetBaseUrl } from '../modules/fleet/registry.mjs';
import { businessOsRegistryFixture } from './helpers/fleet-fixtures.mjs';

const env = {
  EXAMPLE_CLIENT_PUBLIC_BASE_URL_REF: 'https://ops.example.com',
  EXAMPLE_CLIENT_FLEET_AUTH_REF: 'test-token',
  DEV_PUBLIC_BASE_URL_REF: 'https://dev-1.tailnet-test.ts.net',
  DEV_FLEET_AUTH_REF: 'tailscale-token',
  FLEET_PRIVATE_HOSTS: 'dev-1.tailnet-test.ts.net',
};

describe('fleet registry', () => {
  it('loads refs-only BusinessOS deployments and resolves env refs when enabled', () => {
    const registry = parseFleetRegistry(businessOsRegistryFixture(), {
      env,
      remoteRefsEnabled: true,
    });

    assert.equal(registry.deployments.length, 1);
    assert.deepEqual(registry.deployments[0], {
      deploymentId: 'example-client',
      profile: 'businessos-client',
      environment: 'production',
      publicBaseUrlRef: 'EXAMPLE_CLIENT_PUBLIC_BASE_URL_REF',
      baseUrl: 'https://ops.example.com',
      authMode: 'bearer_ref',
      authRef: 'EXAMPLE_CLIENT_FLEET_AUTH_REF',
      token: 'test-token',
      healthContract: 'businessos_diagnostics',
      enabledModules: ['accounting', 'work_queue', 'instance_diagnostics'],
      pollingIntervalSeconds: 120,
      debugFetchOnDegraded: true,
    });
  });

  it('keeps raw refs unresolved when remote refs are disabled', () => {
    const registry = parseFleetRegistry(businessOsRegistryFixture(), {
      env: {},
      remoteRefsEnabled: false,
    });

    assert.equal(registry.deployments[0].baseUrl, null);
    assert.equal(registry.deployments[0].token, null);
    assert.equal(registry.deployments[0].publicBaseUrlRef, 'EXAMPLE_CLIENT_PUBLIC_BASE_URL_REF');
  });

  it('rejects raw URL or token material in registry refs', () => {
    assert.throws(
      () => parseFleetRegistry(businessOsRegistryFixture({
        deployments: [
          {
            ...businessOsRegistryFixture().deployments[0],
            public_base_url_ref: 'https://ops.example.com',
          },
        ],
      })),
      /public_base_url_ref must be env-style ref/
    );

    assert.throws(
      () => parseFleetRegistry(businessOsRegistryFixture({
        deployments: [
          {
            ...businessOsRegistryFixture().deployments[0],
            auth_ref: 'OPERATOR_TOKEN_SECRET',
          },
        ],
      })),
      /looks like inline token material/
    );
  });

  it('rejects unsafe URLs', () => {
    for (const raw of [
      'http://ops.example.com',
      'https://ops.example.com/path',
      'https://user:pass@ops.example.com',
      'https://ops.example.com?token=secret',
      'https://localhost',
      'https://127.0.0.1',
      'https://192.168.1.20',
      'https://dev-1.tailnet-test.ts.net',
    ]) {
      assert.throws(
        () => validateFleetBaseUrl(raw, { deploymentId: 'unsafe', env: {} }),
        /base URL|private/
      );
    }
  });

  it('allows the tailscale host only through the explicit private host ref', () => {
    assert.equal(
      validateFleetBaseUrl('https://dev-1.tailnet-test.ts.net', {
        deploymentId: 'dev',
        env,
        privateHostAllowedRef: 'FLEET_PRIVATE_HOSTS',
      }),
      'https://dev-1.tailnet-test.ts.net'
    );
  });

  it('resolves two real-target shaped deployments from env refs', () => {
    const registry = parseFleetRegistry(businessOsRegistryFixture({
      deployments: [
        businessOsRegistryFixture().deployments[0],
        {
          ...businessOsRegistryFixture().deployments[0],
          deployment_id: 'dev-businessos',
          profile: 'businessos-owner',
          environment: 'production',
          public_base_url_ref: 'DEV_PUBLIC_BASE_URL_REF',
          auth_ref: 'DEV_FLEET_AUTH_REF',
          owner_ref: 'DEV_OWNER_REF',
          contact_ref: 'DEV_CONTACT_REF',
          state_namespace_ref: 'DEV_STATE_NAMESPACE_REF',
          health_route_ref: 'DEV_HEALTH_ROUTE_REF',
          runtime_status_route_ref: 'DEV_RUNTIME_STATUS_ROUTE_REF',
          provider_write_policy_ref: 'DEV_PROVIDER_WRITE_POLICY_REF',
        },
      ],
    }), {
      env,
      remoteRefsEnabled: true,
      privateHostAllowedRef: 'FLEET_PRIVATE_HOSTS',
    });

    assert.deepEqual(
      registry.deployments.map((deployment) => [deployment.deploymentId, deployment.baseUrl]),
      [
        ['example-client', 'https://ops.example.com'],
        ['dev-businessos', 'https://dev-1.tailnet-test.ts.net'],
      ]
    );
  });
});

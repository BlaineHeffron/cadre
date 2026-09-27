import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TLS_ENV_KEYS = ['TLS_ENABLED', 'TLS_REQUIRED', 'TLS_CERT', 'TLS_KEY'];

afterEach(() => {
  for (const key of TLS_ENV_KEYS) delete process.env[key];
});

async function importConfigModule() {
  return import(`../config.mjs?test=${Date.now()}-${Math.random()}`);
}

describe('TLS config', () => {
  it('fails closed when TLS is required but disabled', async () => {
    process.env.TLS_ENABLED = '0';
    process.env.TLS_REQUIRED = '1';
    const { loadTlsOptions } = await importConfigModule();
    assert.throws(() => loadTlsOptions(), /TLS_REQUIRED=1/);
  });

  it('preserves HTTP fallback when TLS is optional', async () => {
    process.env.TLS_ENABLED = '1';
    process.env.TLS_REQUIRED = '0';
    process.env.TLS_CERT = 'missing-cert.pem';
    process.env.TLS_KEY = 'missing-key.pem';
    const { loadTlsOptions } = await importConfigModule();
    assert.equal(loadTlsOptions(), null);
  });
});

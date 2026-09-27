import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function writeExecutable(path, body) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

describe('renew-certs script', () => {
  it('uses the user-managed app directory instead of /opt and restarts the user service', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dueno-renew-certs-'));
    tempDirs.push(tempDir);

    const appDir = join(tempDir, 'workspace');
    const certDir = join(appDir, 'certs');
    const binDir = join(tempDir, 'bin');
    const systemctlLog = join(tempDir, 'systemctl.log');
    await mkdir(certDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(certDir, 'server.crt'), 'old-cert\n');
    await writeFile(join(certDir, 'server.key'), 'old-key\n');

    await writeExecutable(join(binDir, 'openssl'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "x509" ]]; then
  exit 1
fi
if [[ "$1" == "req" ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -keyout)
        keyout="$2"
        shift 2
        ;;
      -out)
        out="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  printf 'new-key\\n' > "$keyout"
  printf 'new-cert\\n' > "$out"
  exit 0
fi
exit 64
`);

    await writeExecutable(join(binDir, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
`);

    const scriptPath = resolve('scripts/renew-certs.sh');
    const { stdout } = await execFileAsync('bash', [scriptPath], {
      cwd: appDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        CADRE_APP_DIR: appDir,
        CADRE_SYSTEMD_SCOPE: 'user',
        CADRE_SERVICE_NAME: 'dueno-monitor-user',
      },
    });

    const cert = await readFile(join(certDir, 'server.crt'), 'utf8');
    const key = await readFile(join(certDir, 'server.key'), 'utf8');
    const systemctlCalls = await readFile(systemctlLog, 'utf8');

    assert.match(stdout, /Certificate renewed/);
    assert.equal(cert, 'new-cert\n');
    assert.equal(key, 'new-key\n');
    assert.match(systemctlCalls, /^--user restart dueno-monitor-user$/m);
  });
});

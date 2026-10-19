import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

it('cadre CLI reads its own checkout .env and state dir from any cwd, with shell values winning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cadre-cli-'));
  const checkout = join(root, 'live');
  try {
    await mkdir(join(checkout, 'scripts'), { recursive: true });
    await copyFile(resolve('scripts/cadre.mjs'), join(checkout, 'scripts', 'cadre.mjs'));
    for (const name of ['config.mjs', 'modules', 'node_modules']) await symlink(resolve(name), join(checkout, name));
    await writeFile(join(checkout, '.env'), [
      'CADRE_ROLE=worker', 'HOST=127.0.0.9', 'PORT=4320',
      'CADRE_FLEET_PRIVATE_HOSTS_REF=CADRE_MACHINE_HOSTS', 'CADRE_MACHINE_HOSTS=127.0.0.1', '',
    ].join('\n'));
    // No NODE_TEST_CONTEXT: the child must behave as an operator's shell does.
    const env = { PATH: process.env.PATH, HOME: root, HOST: '127.0.0.2' };
    const cli = (...args) => execFileAsync(process.execPath, [join(checkout, 'scripts', 'cadre.mjs'), ...args], { env, cwd: root });

    const { stdout } = await cli('pair');
    assert.match(stdout, /^http:\/\/127\.0\.0\.2:4320\/#[^.]+\.[A-Z0-9]+\n$/);
    await stat(join(checkout, '.dueno', 'state', 'machines'));

    // The allowlist from .env accepts the link, so add gets as far as dialing the (absent) worker.
    await assert.rejects(cli('machine', 'add', 'w1', 'http://127.0.0.1:9/#m.CODE'), { stderr: /machine_unreachable/ });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

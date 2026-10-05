import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};

describe('install-fleet-service script', () => {
  it('renders hardened fleet and backup user units', async () => {
    const script = await readFile(resolve('scripts/install-fleet-service.sh'), 'utf8');

    assert.match(script, /UNIT="\$SYSTEMD_USER_DIR\/dueno-fleet\.service"/);
    assert.match(script, /BACKUP_SERVICE="\$SYSTEMD_USER_DIR\/dueno-fleet-backup\.service"/);
    assert.match(script, /BACKUP_TIMER="\$SYSTEMD_USER_DIR\/dueno-fleet-backup\.timer"/);
    assert.match(script, /NODE_BIN="\$\(bash "\$DEV_DIR\/scripts\/resolve-node-bin\.sh"\)"/);
    assert.match(script, /NPM_BIN="\$\(dirname "\$NODE_BIN"\)\/npm"/);
    assert.match(script, /^ExecStart=\$NPM_BIN run backup:state$/m);
    assert.match(script, /^systemctl --user enable dueno-fleet-backup\.timer$/m);
    assert.match(script, /^systemctl --user start dueno-fleet-backup\.timer$/m);
    assert.doesNotMatch(script, /dueno-fleet-backup\.timer.*\|\| true/);

    assert.match(script, /^KillMode=process$/m);
    assert.match(script, /^NoNewPrivileges=true$/m);
    assert.match(script, /^ProtectSystem=strict$/m);
    assert.match(script, /mkdir -p "\$HOME\/\.dueno-fleet"/);
    assert.match(script, /^ReadWritePaths=\$HOME\/\.dueno-fleet .*\$LIVE_DIR\/\.dueno.*\$DEV_DIR\/\.dueno/m);
    assert.match(script, /^ReadWritePaths=\$HOME\/\.dueno-fleet \$LIVE_DIR\/\.dueno \$DEV_DIR\/\.dueno$/m);
    assert.match(script, /^ReadOnlyPaths=\/var\/log\/auth\.log$/m);
    assert.match(script, /^ProtectKernelTunables=true$/m);
    assert.match(script, /^ProtectKernelModules=true$/m);
    assert.match(script, /^ProtectControlGroups=true$/m);
    assert.match(script, /^RestrictSUIDSGID=true$/m);
    assert.doesNotMatch(script, /ExecStartPre=.*sync-main\.sh/);
    assert.match(script, /^ExecStartPre=\$NODE_BIN scripts\/check-node-runtime\.mjs$/m);
    assert.match(script, /^ExecStartPre=\$NODE_BIN scripts\/check-syntax\.mjs$/m);
  });
});

describe('host path defaults', () => {
  it('derive the dev clone from the live worktree and refuse to run outside git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-host-defaults-'));
    const dev = join(root, 'dev');
    const live = `${dev}-live`;
    const bin = join(root, 'bin');
    const git = (...args) => execFileAsync('git', args, { env });
    const env = {
      ...coverageEnv,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: root,
      CLAUDE_TEST_PLUGIN: join(live, 'scripts', 'agent-hooks', 'claude-fleet'),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      CADRE_FLEET_NO_INSTALL: '1',
    };
    const scripts = ['install-fleet-service.sh', 'sync-main.sh', 'resolve-node-bin.sh', 'check-node-runtime.mjs', 'check-syntax.mjs', 'install-agent-slice.sh'];
    try {
      await mkdir(join(dev, 'scripts'), { recursive: true });
      await mkdir(bin);
      await writeFile(join(bin, 'systemctl'), '#!/bin/bash\nexit 0\n');
      await chmod(join(bin, 'systemctl'), 0o755);
      await writeFile(join(bin, 'claude'), '#!/bin/sh\n[ "$#" = 3 ] && [ "$1" = plugin ] && [ "$2" = validate ] && [ "$3" = "$CLAUDE_TEST_PLUGIN" ]\n');
      await chmod(join(bin, 'claude'), 0o755);
      for (const name of scripts) await copyFile(resolve('scripts', name), join(dev, 'scripts', name));
      await writeFile(join(dev, '.gitignore'), '.env\n');
      await git('init', '-q', '-b', 'main', dev);
      await git('-C', dev, 'add', '-A');
      await git('-C', dev, 'commit', '-qm', 'init');
      await git('clone', '-q', '--bare', dev, join(root, 'origin.git'));
      await git('-C', dev, 'remote', 'add', 'origin', join(root, 'origin.git'));
      await git('-C', dev, 'worktree', 'add', '-q', '--detach', live);
      await writeFile(join(dev, '.env'), 'X=1\n');

      await execFileAsync('bash', [join(live, 'scripts', 'sync-main.sh')], { env, cwd: live });
      assert.equal(await readlink(join(live, '.env')), join(dev, '.env'));

      await execFileAsync('bash', [join(live, 'scripts', 'install-fleet-service.sh')], { env, cwd: live });
      const unit = await readFile(join(root, 'config', 'systemd', 'user', 'dueno-fleet.service'), 'utf8');
      assert.match(unit, new RegExp(`^WorkingDirectory=${live}$`, 'm'));
      assert.match(unit, new RegExp(`^Environment=CADRE_FLEET_STATE_SRC=${dev}$`, 'm'));

      // Outside git it must stop before touching systemd (no agent slice written).
      const loose = join(root, 'loose');
      await mkdir(join(loose, 'scripts'), { recursive: true });
      for (const name of scripts) await copyFile(resolve('scripts', name), join(loose, 'scripts', name));
      await rm(join(root, 'config'), { recursive: true });
      await assert.rejects(execFileAsync('bash', ['scripts/install-fleet-service.sh'], { env, cwd: loose }), /not a git repository/);
      await assert.rejects(stat(join(root, 'config')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('sync-main script', () => {
  it('runs the syntax gate after dependency sync', async () => {
    const script = await readFile(resolve('scripts/sync-main.sh'), 'utf8');

    assert.match(script, /log "checking syntax"\n"\$NODE_BIN" "\$LIVE_DIR\/scripts\/check-syntax\.mjs"/);
    assert.match(script, /NODE_BIN="\$\(bash "\$LIVE_DIR\/scripts\/resolve-node-bin\.sh"\)"/);
    assert.match(script, /"\$NPM_BIN" ci --no-audit --no-fund/);
  });
});

describe('Node runtime contract', () => {
  it('pins the minimum consistently', async () => {
    const [versionFile, packageJson, lockfile, checker, resolver] = await Promise.all([
      readFile(resolve('.node-version'), 'utf8'),
      readFile(resolve('package.json'), 'utf8').then(JSON.parse),
      readFile(resolve('package-lock.json'), 'utf8').then(JSON.parse),
      readFile(resolve('scripts/check-node-runtime.mjs'), 'utf8'),
      readFile(resolve('scripts/resolve-node-bin.sh'), 'utf8'),
    ]);

    assert.equal(versionFile.trim(), '22.19.0');
    assert.equal(packageJson.engines.node, '>=22.19.0');
    assert.equal(lockfile.packages[''].engines.node, '>=22.19.0');
    assert.match(checker, /REQUIRED_NODE_VERSION = '22\.19\.0'/);
    assert.match(resolver, /REQUIRED_NODE_VERSION="22\.19\.0"/);
  });
});

describe('server script', () => {
  it('syncs the live directory then installs the agent slice before restart, and update aliases that path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-server-script-'));
    const live = join(root, 'live');
    const bin = join(root, 'bin');
    const orderLog = join(root, 'order.log');
    await mkdir(join(live, 'scripts'), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(live, 'scripts', 'sync-main.sh'), '#!/bin/bash\nprintf "sync_live\n" >> "$ORDER_LOG"\n');
    await writeFile(join(live, 'scripts', 'install-agent-slice.sh'), '#!/bin/bash\nprintf "install_agent_slice\n" >> "$ORDER_LOG"\n');
    await writeFile(join(bin, 'systemctl'), '#!/bin/bash\nprintf "systemctl %s\n" "$*" >> "$ORDER_LOG"\n');
    await writeFile(join(bin, 'curl'), '#!/bin/bash\nexit 0\n');
    await writeFile(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n');
    await chmod(join(live, 'scripts', 'sync-main.sh'), 0o755);
    await chmod(join(live, 'scripts', 'install-agent-slice.sh'), 0o755);
    await chmod(join(bin, 'systemctl'), 0o755);
    await chmod(join(bin, 'curl'), 0o755);
    await chmod(join(bin, 'sleep'), 0o755);
    const env = {
      ...coverageEnv,
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      CADRE_FLEET_LIVE_DIR: live,
      ORDER_LOG: orderLog,
    };
    try {
      for (const action of ['restart', 'update']) {
        await writeFile(orderLog, '');
        await execFileAsync('bash', [resolve('scripts/server.sh'), action], { env });
        assert.equal(
          await readFile(orderLog, 'utf8'),
          'sync_live\ninstall_agent_slice\nsystemctl --user restart dueno-fleet\n',
          action,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

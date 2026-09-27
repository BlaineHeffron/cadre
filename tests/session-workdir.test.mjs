import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SESSION_WORKDIR, expandHomePath, normalizeSessionWorkDir } from '../modules/sessions/workdir.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('session workdir normalization', () => {
  it('expands home-relative paths before launch', () => {
    assert.equal(expandHomePath('~/projects/example'), resolve(homedir(), 'projects/example'));
    assert.equal(expandHomePath('~'), homedir());
  });

  it('normalizes relative directories to absolute paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dueno-session-workdir-'));
    tempDirs.push(tempDir);
    const projectDir = join(tempDir, 'project');
    await mkdir(projectDir);

    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      assert.equal(await normalizeSessionWorkDir('project'), projectDir);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('uses the fleet repo as the default empty work directory', async () => {
    assert.equal(DEFAULT_SESSION_WORKDIR, '~/projects/cadre');

    const tempDir = await mkdtemp(join(tmpdir(), 'dueno-session-default-workdir-'));
    tempDirs.push(tempDir);
    const previousDefault = process.env.CADRE_DEFAULT_AGENT_WORKDIR;
    process.env.CADRE_DEFAULT_AGENT_WORKDIR = tempDir;
    try {
      assert.equal(await normalizeSessionWorkDir(''), tempDir);
    } finally {
      if (previousDefault === undefined) delete process.env.CADRE_DEFAULT_AGENT_WORKDIR;
      else process.env.CADRE_DEFAULT_AGENT_WORKDIR = previousDefault;
    }
  });

  it('rejects missing work directories', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dueno-session-missing-workdir-'));
    tempDirs.push(tempDir);
    const missingDir = join(tempDir, 'missing');

    await assert.rejects(
      normalizeSessionWorkDir(missingDir),
      /Working directory does not exist/
    );
  });

  it('rejects file paths as work directories', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dueno-session-file-workdir-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'not-a-directory.txt');
    await writeFile(filePath, 'not a directory');

    await assert.rejects(
      normalizeSessionWorkDir(filePath),
      /Working directory is not a directory/
    );
  });
});

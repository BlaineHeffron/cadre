import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateImage, GROK_IMAGE_ARGS, runImageCli } from '../modules/integrations/image-generation.mjs';
import { createImageGenServer } from '../scripts/image-gen-mcp.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
// Real PNG fixtures: 3x2 RGBA/RGB, 1x1 gray-alpha and palette transparency.
const landscape = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAC0lEQVR4nGNgwAUAABoAAbw84EEAAAAASUVORK5CYII=', 'base64');
const opaque = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=', 'base64');
const grayAlpha = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAbitOmMAAAAASUVORK5CYII=', 'base64');
const paletteAlpha = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=', 'base64');
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function outputEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-image-test-'));
  dirs.push(dir);
  return { DEFAULT_OUTPUT_DIR: dir };
}

describe('subscription image generation', () => {
  async function referenceDir() {
    const dir = await mkdtemp(join(process.cwd(), '.image-reference-test-'));
    dirs.push(dir);
    return dir;
  }

  it('rejects invalid reference counts, paths, types and sizes before provider calls', async () => {
    const env = await outputEnv();
    const dir = await referenceDir();
    const invalid = join(dir, 'invalid');
    await writeFile(invalid, 'not an image');
    const huge = join(dir, 'huge.png');
    await writeFile(huge, png);
    await truncate(huge, 10 * 1024 * 1024 + 1);
    const external = join(env.DEFAULT_OUTPUT_DIR, 'outside.png');
    await writeFile(external, png);
    const linked = join(dir, 'linked.png');
    await symlink(external, linked);
    const options = { env, run: () => assert.fail('must not spend quota') };
    for (const provider of ['openai', 'xai']) {
      for (const [reference_images, error] of [
        [[], /1–4/], [Array(5).fill(invalid), /1–4/], ['bad', /1–4/], [[null], /1–4/], [[' '], /1–4/],
        [[join(dir, 'missing')], /does not exist/], [[external], /working directory/], [[linked], /working directory/],
        [[dir], /regular file/], [[invalid], /magic bytes/], [[huge], /10 MB/],
      ]) await assert.rejects(generateImage({ provider, prompt: 'test', reference_images }, options), error);
    }
  });

  it('copies four verified references into Codex cwd and passes separate -i arguments', async () => {
    const env = await outputEnv();
    const dir = await referenceDir();
    const fixtures = [landscape, Buffer.from([255, 216, 255, 0]), Buffer.from('RIFFxxxxWEBP'), grayAlpha];
    const reference_images = await Promise.all(fixtures.map(async (bytes, i) => {
      const path = join(dir, `source-${i}.data`);
      await writeFile(path, bytes);
      return path;
    }));
    const alias = join(dir, 'alias');
    await symlink(reference_images[0], alias);
    reference_images[0] = alias;
    let workDir;
    await generateImage({ provider: 'openai', prompt: 'edit armor', reference_images }, { env,
      run: async (command, args, { cwd }) => {
        workDir = cwd;
        assert.equal(command, 'codex');
        assert.equal(args.at(-2), '--');
        const paths = args.slice(8, -2);
        assert.equal(paths.length, 8);
        for (let i = 0; i < 4; i++) {
          assert.equal(paths[i * 2], '-i');
          assert.ok(paths[i * 2 + 1].startsWith(`${cwd}/reference-`));
          assert.deepEqual(await readFile(paths[i * 2 + 1]), fixtures[i]);
        }
        assert.match(args.at(-1), /attached images as references or for editing/);
        await writeFile(join(cwd, 'image.png'), landscape);
      },
    });
    await assert.rejects(readdir(workDir), /ENOENT/);
  });

  it('allows only Grok image_edit for references and saves its verified result', async () => {
    const env = await outputEnv();
    env.HOME = env.DEFAULT_OUTPUT_DIR;
    const dir = await referenceDir();
    const source = join(dir, 'source.png');
    await writeFile(source, landscape);
    const imagePath = join(env.HOME, '.grok/sessions/test/images/edit.png');
    await mkdir(join(env.HOME, '.grok/sessions/test/images'), { recursive: true });
    await writeFile(imagePath, landscape);
    const result = await generateImage({ provider: 'xai', prompt: 'edit armor', reference_images: [source] }, { env,
      run: async (command, args, { cwd }) => {
        assert.equal(command, 'grok');
        assert.equal(args[args.indexOf('--allow') + 1], 'image_edit');
        assert.equal(args[args.indexOf('--tools') + 1], 'image_edit');
        const denied = args[args.indexOf('--disallowed-tools') + 1].split(',');
        assert.ok(denied.includes('image_gen'));
        assert.ok(!denied.includes('image_edit'));
        const copy = join(cwd, 'reference-1.png');
        assert.deepEqual(await readFile(copy), landscape);
        assert.ok(args.at(-1).includes(JSON.stringify([copy])));
        return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ type: 'ImageEdit', path: imagePath }) }] } });
      },
    });
    assert.deepEqual(await readFile(result.path), landscape);
  });

  it('rejects unsupported options before invoking providers', async () => {
    const env = await outputEnv();
    const options = { env, run: () => assert.fail('must not spend quota') };
    for (const provider of ['openai', 'xai']) {
      for (const input of [{ aspect_ratio: 'bad' }, { background: 'bad' }, { aspect_ratio: null }]) {
        await assert.rejects(generateImage({ provider, prompt: 'test', ...input }, options), /does not support/);
      }
    }
    for (const provider of ['openai', 'xai']) {
      await assert.rejects(generateImage({ provider, prompt: 'test', aspect_ratio: '4:3' }, options), /does not support aspect_ratio/);
    }
    await assert.rejects(generateImage({ provider: 'xai', prompt: 'test', background: 'transparent' }, options), /does not support background/);
    await assert.rejects(generateImage({ provider: 'google', prompt: 'test' }, options), /Unknown image provider: google/);
  });

  it('passes Codex ratio hints and transparency and verifies PNG output before saving', async () => {
    const env = await outputEnv();
    for (const [bytes, aspect_ratio] of [[landscape, '3:2'], [grayAlpha, '1:1'], [paletteAlpha, '1:1']]) {
      const result = await generateImage({ provider: 'openai', prompt: 'icon', aspect_ratio, background: 'transparent' }, { env,
        run: async (_command, args, { cwd }) => {
          assert.ok(args.at(-1).includes('transparent_background=true'));
          assert.ok(args.at(-1).includes(`Required output aspect ratio: ${aspect_ratio}`));
          await writeFile(join(cwd, 'image.png'), bytes);
        },
      });
      assert.deepEqual(await readFile(result.path), bytes);
    }
    await generateImage({ provider: 'openai', prompt: 'icon', background: 'opaque' }, { env,
      run: async (_command, args, { cwd }) => {
        assert.ok(args.at(-1).includes('transparent_background=false'));
        await writeFile(join(cwd, 'image.png'), opaque);
      },
    });
    const before = await readdir(env.DEFAULT_OUTPUT_DIR);
    for (const bytes of [opaque, png, Buffer.from([255, 216, 255])]) {
      await assert.rejects(generateImage({ provider: 'openai', prompt: 'icon', background: 'transparent' }, { env,
        run: async (_command, _args, { cwd }) => writeFile(join(cwd, 'image.png'), bytes),
      }), /without an alpha channel/);
    }
    for (const bytes of [landscape, png, Buffer.from([255, 216, 255])]) {
      await assert.rejects(generateImage({ provider: 'openai', prompt: 'icon', aspect_ratio: '2:3' }, { env,
        run: async (_command, _args, { cwd }) => writeFile(join(cwd, 'image.png'), bytes),
      }), /did not return the requested aspect_ratio/);
    }
    assert.deepEqual(await readdir(env.DEFAULT_OUTPUT_DIR), before);
  });

  it('defaults to OpenAI through Codex when no provider is given', async () => {
    const env = await outputEnv();
    const commands = [];
    const result = await generateImage({ prompt: 'a square' }, { env,
      run: async (command, _args, { cwd }) => { commands.push(command); await writeFile(join(cwd, 'image.png'), png); },
    });
    assert.deepEqual(commands, ['codex']);
    assert.equal(result.provider, 'openai');
    assert.ok(result.path.startsWith(join(env.DEFAULT_OUTPUT_DIR, 'openai-')));
  });

  it('runs isolated Codex with one framed prompt and saves verified output', async () => {
    const env = { ...await outputEnv(), HOME: '/home/test', PATH: '/bin', OPENAI_API_KEY: 'never-forward', CODEX_API_KEY: 'never-forward', CADRE_TOKEN: 'never-forward', DUENO_TOKEN: 'never-forward' };
    const prompt = 'a blue square; $(touch bad) `x` "quoted"\nsecond line';
    let workDir;
    const result = await generateImage({ provider: 'openai', prompt, output_path: 'custom/test.png' }, {
      env, run: async (command, args, options) => {
        assert.equal(command, 'codex');
        assert.deepEqual(args.slice(0, 8), ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', '-C', options.cwd]);
        assert.equal(args.length, 9);
        assert.ok(args[8].includes(JSON.stringify(prompt)));
        assert.ok(args[8].includes(join(options.cwd, 'image.png')));
        assert.deepEqual(options.env, { HOME: '/home/test', PATH: '/bin' });
        assert.equal(options.timeoutMs, 180_000);
        assert.notEqual(options.cwd, env.DEFAULT_OUTPUT_DIR);
        workDir = options.cwd;
        await writeFile(join(workDir, 'image.png'), png);
      },
    });
    assert.deepEqual(result, { provider: 'openai', path: join(env.DEFAULT_OUTPUT_DIR, 'custom/test.png'), mimeType: 'image/png', bytes: png.length });
    assert.deepEqual(await readFile(result.path), png);
    await assert.rejects(readFile(join(workDir, 'image.png')), /ENOENT/);
  });

  it('rejects absolute and traversal output escapes before invoking providers', async () => {
    const env = await outputEnv();
    for (const output_path of ['/tmp/outside.png', '../outside.png']) {
      await assert.rejects(generateImage({ provider: 'openai', prompt: 'test', output_path }, {
        env, run: () => assert.fail('invalid output must not spend quota'),
      }), /must stay inside/);
    }
  });

  it('rejects symlink escapes and existing output-file symlinks', async () => {
    const env = await outputEnv();
    const external = await outputEnv();
    await symlink(external.DEFAULT_OUTPUT_DIR, join(env.DEFAULT_OUTPUT_DIR, 'linked'));
    const run = async (_command, _args, { cwd }) => writeFile(join(cwd, 'image.png'), png);
    await assert.rejects(generateImage({ provider: 'openai', prompt: 'test', output_path: 'linked/out.png' }, { env, run }), /must stay inside/);
    const outside = join(external.DEFAULT_OUTPUT_DIR, 'outside.png');
    await writeFile(outside, 'unchanged');
    await symlink(outside, join(env.DEFAULT_OUTPUT_DIR, 'out.png'));
    await assert.rejects(generateImage({ provider: 'openai', prompt: 'test', output_path: 'out.png' }, { env, run }), /EEXIST/);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  });

  it('rejects missing and invalid CLI output and propagates CLI failure', async () => {
    const env = await outputEnv();
    await assert.rejects(generateImage({ provider: 'openai', prompt: 'test' }, { env, run: async () => {} }), /without saving an image/);
    await assert.rejects(generateImage({ provider: 'openai', prompt: 'test' }, { env,
      run: async (_command, _args, { cwd }) => writeFile(join(cwd, 'image.png'), 'not an image'),
    }), /no valid PNG/);
    await assert.rejects(generateImage({ provider: 'openai', prompt: 'test' }, { env,
      run: async () => { throw new Error('Codex image generation timed out.'); },
    }), /timed out/);
  });

  it('verifies JPEG and WebP output and selects matching file extensions', async () => {
    const env = await outputEnv();
    env.HOME = env.DEFAULT_OUTPUT_DIR;
    await mkdir(join(env.HOME, '.grok/sessions/test'), { recursive: true });
    for (const [bytes, mimeType, extension] of [
      [Buffer.from([255, 216, 255, 0]), 'image/jpeg', 'jpg'],
      [Buffer.from('RIFFxxxxWEBP'), 'image/webp', 'webp'],
    ]) {
      const imagePath = join(env.HOME, `.grok/sessions/test/image.${extension}`);
      await writeFile(imagePath, bytes);
      const result = await generateImage({ provider: 'xai', prompt: 'test' }, { env,
        run: async () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ type: 'ImageGen', path: imagePath }) }] } }),
      });
      assert.equal(result.mimeType, mimeType);
      assert.ok(result.path.endsWith(`.${extension}`));
      assert.deepEqual(await readFile(result.path), bytes);
    }
  });

  it('runs the verified Grok flags and saves only an ImageGen tool-result path', async () => {
    const env = await outputEnv();
    env.HOME = env.DEFAULT_OUTPUT_DIR;
    env.PATH = '/bin';
    env.XAI_API_KEY = 'never-forward';
    const imagePath = join(env.HOME, '.grok/sessions/test/images/1.jpg');
    await mkdir(join(env.HOME, '.grok/sessions/test/images'), { recursive: true });
    const jpeg = Buffer.from([255, 216, 255, 0]);
    await writeFile(imagePath, jpeg);
    assert.deepEqual(GROK_IMAGE_ARGS, [
      '--no-subagents', '--max-turns', '3', '--permission-mode', 'dontAsk', '--allow', 'image_gen',
      '--disallowed-tools', 'run_terminal_command,read_file,search_replace,list_dir,grep,write,spawn_subagent,scheduler_create,scheduler_delete,monitor,workflow,image_edit,image_to_video,reference_to_video',
      '--disable-web-search', '--output-format', 'streaming-messages-json',
    ]);
    const event = { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ type: 'ImageGen', path: imagePath }) }] } };
    const prompt = 'blue square $(shell)';
    const result = await generateImage({ provider: 'xai', prompt, aspect_ratio: '9:16', background: 'opaque' }, { env,
      run: async (command, args, options) => {
        assert.equal(command, 'grok');
        assert.deepEqual(args.slice(0, -1), ['--cwd', options.cwd, ...GROK_IMAGE_ARGS, '-p']);
        assert.ok(args.at(-1).includes(JSON.stringify(prompt)));
        assert.ok(args.at(-1).includes('aspect_ratio="9:16"'));
        assert.deepEqual(options.env, { HOME: env.HOME, PATH: '/bin' });
        assert.equal(options.timeoutMs, 180_000);
        return `unrelated line\n${JSON.stringify(event)}\n`;
      },
    });
    assert.equal(result.mimeType, 'image/jpeg');
    assert.deepEqual(await readFile(result.path), jpeg);
  });

  it('rejects absent/error Grok events and real paths outside its sessions directory', async () => {
    const env = await outputEnv();
    env.HOME = env.DEFAULT_OUTPUT_DIR;
    const sessions = join(env.HOME, '.grok/sessions');
    await mkdir(sessions, { recursive: true });
    const outside = join(env.HOME, 'outside.jpg');
    await writeFile(outside, png);
    const linked = join(sessions, 'linked.jpg');
    await symlink(outside, linked);
    const event = (path, is_error = false) => JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', is_error, content: JSON.stringify({ type: 'ImageGen', path }) },
    ] } });
    for (const [output, message] of [
      [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: outside }] } }), /Grok produced no image/],
      [event(outside, true), /Grok produced no image/],
      [event(join(sessions, 'missing.jpg')), /Grok produced no image file/],
      [event(outside), /outside the subscription image sessions directory/],
      [event(linked), /outside the subscription image sessions directory/],
    ]) await assert.rejects(generateImage({ provider: 'xai', prompt: 'test' }, {
      env, run: async () => output,
    }), message);
    await assert.rejects(generateImage({ provider: 'unknown', prompt: 'test' }), /Unknown image provider/);
    await assert.rejects(generateImage({ provider: 'openai', prompt: '' }), /prompt is required/);
  });

  it('bounds CLI execution and reports spawn and exit failures', async () => {
    const cwd = (await outputEnv()).DEFAULT_OUTPUT_DIR;
    const options = { cwd, env: {}, timeoutMs: 100 };
    await assert.rejects(runImageCli('/missing/codex', [], options), /could not start/);
    await assert.rejects(runImageCli(process.execPath, ['-e', 'process.exit(7)'], options), /exit 7/);
    await assert.rejects(runImageCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options), /timed out/);
  });

  it('exposes generation and provider errors through the MCP tool', async () => {
    const server = createImageGenServer(async (input) => {
      assert.equal(input.prompt, 'test');
      if (input.provider !== 'xai') assert.deepEqual(input, { prompt: 'test', aspect_ratio: '3:2', background: 'opaque', reference_images: ['ref.png'] });
      if (input.provider === 'xai') throw new Error('not available on subscription');
      return { provider: input.provider, path: '/test.png', mimeType: 'image/png', bytes: 9 };
    });
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['generate_image']);
      const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'test', aspect_ratio: '3:2', background: 'opaque', reference_images: ['ref.png'] } });
      assert.equal(result.structuredContent.path, '/test.png');
      const google = await client.callTool({ name: 'generate_image', arguments: { provider: 'google', prompt: 'test' } });
      assert.equal(google.isError, true);
      const unavailable = await client.callTool({ name: 'generate_image', arguments: { provider: 'xai', prompt: 'test' } });
      assert.equal(unavailable.isError, true);
      assert.equal(unavailable.content[0].text, 'not available on subscription');
    } finally { await client.close(); await server.close(); }
  });
});

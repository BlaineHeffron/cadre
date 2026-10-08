import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateImage, GOOGLE_IMAGE_MODEL, GROK_IMAGE_ARGS, runImageCli } from '../modules/integrations/image-generation.mjs';
import { createImageGenServer } from '../scripts/image-gen-mcp.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function outputEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-image-test-'));
  dirs.push(dir);
  return { DEFAULT_OUTPUT_DIR: dir, IMAGE_GEN_PROXY_KEY_FILE: join(dir, 'proxy-key') };
}

describe('subscription image generation', () => {
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

  it('reads the proxy key at call time and constructs a loopback Gemini request', async () => {
    const env = await outputEnv();
    let calls = 0;
    const options = { env,
      readKey: async (path, encoding) => {
        assert.equal(path, env.IMAGE_GEN_PROXY_KEY_FILE);
        assert.equal(encoding, 'utf8');
        return `dummy-${++calls}\n`;
      },
      fetchImpl: async (url, request) => {
        assert.equal(url, `http://127.0.0.1:8317/v1beta/models/${GOOGLE_IMAGE_MODEL}:generateContent`);
        assert.equal(request.redirect, 'error');
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.Authorization, `Bearer dummy-${calls}`);
        assert.ok(request.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(request.body), {
          contents: [{ role: 'user', parts: [{ text: 'a square' }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '1K' } },
        });
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] }) };
      },
    };
    for (let i = 0; i < 2; i++) {
      const result = await generateImage({ provider: 'google', prompt: 'a square' }, options);
      assert.ok(result.path.startsWith(env.DEFAULT_OUTPUT_DIR));
      assert.deepEqual(await readFile(result.path), png);
    }
    assert.equal(calls, 2);
  });

  it('verifies JPEG and WebP output and selects matching file extensions', async () => {
    const env = await outputEnv();
    for (const [bytes, mimeType, extension] of [
      [Buffer.from([255, 216, 255, 0]), 'image/jpeg', 'jpg'],
      [Buffer.from('RIFFxxxxWEBP'), 'image/webp', 'webp'],
    ]) {
      const result = await generateImage({ provider: 'google', prompt: 'test' }, {
        env, readKey: async () => 'dummy',
        fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: {
          parts: [{ inlineData: { data: bytes.toString('base64') } }],
        } }] }) }),
      });
      assert.equal(result.mimeType, mimeType);
      assert.ok(result.path.endsWith(`.${extension}`));
      assert.deepEqual(await readFile(result.path), bytes);
    }
  });

  it('returns clear Google errors without echoing keys or upstream bodies', async () => {
    const env = await outputEnv();
    const input = { provider: 'google', prompt: 'test' };
    await assert.rejects(generateImage(input, { env }), /key file and Google login/);
    await assert.rejects(generateImage(input, { env, readKey: async () => '' }), /key file is empty/);
    const options = { env, readKey: async () => 'secret-dummy' };
    for (const [fetchImpl, message] of [
      [async () => { throw new Error('secret-dummy'); }, /could not reach local/],
      [async () => ({ ok: false, status: 401, json: async () => ({ error: 'secret-dummy' }) }), /HTTP 401/],
      [async () => ({ ok: true, json: async () => { throw new Error('secret-dummy'); } }), /invalid response/],
      [async () => ({ ok: true, json: async () => ({ candidates: [] }) }), /returned no image/],
      [async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'bm90IGFuIGltYWdl' } }] } }] }) }), /no valid PNG/],
    ]) {
      await assert.rejects(generateImage(input, { ...options, fetchImpl }), (error) => {
        assert.match(error.message, message);
        assert.equal(error.message.includes('secret-dummy'), false);
        return true;
      });
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
    const result = await generateImage({ provider: 'xai', prompt }, { env,
      run: async (command, args, options) => {
        assert.equal(command, 'grok');
        assert.deepEqual(args.slice(0, -1), ['--cwd', options.cwd, ...GROK_IMAGE_ARGS, '-p']);
        assert.ok(args.at(-1).includes(JSON.stringify(prompt)));
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
      if (input.provider === 'xai') throw new Error('not available on subscription');
      return { provider: input.provider, path: '/test.png', mimeType: 'image/png', bytes: 9 };
    });
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['generate_image']);
      const result = await client.callTool({ name: 'generate_image', arguments: { provider: 'google', prompt: 'test' } });
      assert.equal(result.structuredContent.path, '/test.png');
      const unavailable = await client.callTool({ name: 'generate_image', arguments: { provider: 'xai', prompt: 'test' } });
      assert.equal(unavailable.isError, true);
      assert.equal(unavailable.content[0].text, 'not available on subscription');
    } finally { await client.close(); await server.close(); }
  });
});

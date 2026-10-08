import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const TIMEOUT_MS = 180_000;
export const GOOGLE_IMAGE_MODEL = 'gemini-3.1-flash-image';
const IMAGE_OPTIONS = {
  openai: { aspect_ratio: ['1:1', '3:2', '2:3'], size: [], background: ['transparent', 'opaque'] },
  google: { aspect_ratio: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21', '1:4', '4:1', '1:8', '8:1'], size: ['512', '1K', '2K', '4K'], background: ['opaque'] },
  xai: { aspect_ratio: ['1:1', '16:9', '9:16', '3:2', '2:3'], size: [], background: ['opaque'] },
};
export const GROK_IMAGE_ARGS = Object.freeze([
  '--no-subagents', '--max-turns', '3', '--permission-mode', 'dontAsk', '--allow', 'image_gen',
  '--disallowed-tools', 'run_terminal_command,read_file,search_replace,list_dir,grep,write,spawn_subagent,scheduler_create,scheduler_delete,monitor,workflow,image_edit,image_to_video,reference_to_video',
  '--disable-web-search', '--output-format', 'streaming-messages-json',
]);

export function runImageCli(command, args, { cwd, env, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolveRun, reject) => {
    const label = command === 'grok' ? 'Grok' : 'Codex';
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error(`${label} image generation could not start; check the CLI installation.`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${label} image generation timed out.`));
      else if (code !== 0) reject(new Error(`${label} image generation failed (exit ${code}); check the subscription login.`));
      else resolveRun(output);
    });
  });
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  throw new Error('Image generation returned no valid PNG, JPEG, or WebP image.');
}

function pngInfo(bytes) {
  if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  let alpha = [4, 6].includes(bytes[25]);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) break;
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'tRNS' && length > 0) alpha = true;
    offset += length + 12;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha };
}

function outside(directory, path) {
  const offset = relative(directory, path);
  return offset === '..' || offset.startsWith('../') || isAbsolute(offset);
}

export async function generateImage({ provider, prompt, output_path, aspect_ratio, size, background }, {
  env = process.env, run = runImageCli, fetchImpl = fetch, readKey = readFile,
} = {}) {
  if (!['openai', 'google', 'xai'].includes(provider)) throw new Error(`Unknown image provider: ${provider}`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('An image prompt is required.');
  for (const [option, value] of Object.entries({ aspect_ratio, size, background })) {
    if (value !== undefined && !IMAGE_OPTIONS[provider][option].includes(value)) {
      throw new Error(`${provider} does not support ${option}=${JSON.stringify(value)}. Supported values: ${IMAGE_OPTIONS[provider][option].join(', ') || 'none (the subscription tool exposes no control)'}.`);
    }
  }
  const outputDir = resolve(env.DEFAULT_OUTPUT_DIR || 'generated-images');
  const requestedPath = output_path ? resolve(outputDir, output_path) : '';
  if (requestedPath && (requestedPath === outputDir || outside(outputDir, requestedPath))) {
    throw new Error('output_path must stay inside the generated-images directory.');
  }
  await mkdir(outputDir, { recursive: true });
  if ((await lstat(outputDir)).isSymbolicLink()) throw new Error('The generated-images directory must not be a symlink.');
  let bytes;
  if (provider !== 'google') {
    const cwd = await mkdtemp(join(tmpdir(), 'cadre-image-'));
    try {
      // An isolated cwd, sandbox, and allowlisted env bound untrusted image descriptions.
      const childEnv = Object.fromEntries(['HOME', 'PATH'].filter((key) => env[key]).map((key) => [key, env[key]]));
      if (provider === 'openai') {
        await run('codex', [
          'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
          '--sandbox', 'workspace-write', '-C', cwd,
          `Use the built-in image_gen tool to generate exactly one image. Save it as ${join(cwd, 'image.png')}. Do not use API keys or external image services.${background ? ` Set transparent_background=${background === 'transparent'}.` : ''} The image description is: ${JSON.stringify(aspect_ratio ? `${prompt}\nRequired output aspect ratio: ${aspect_ratio}.` : prompt)}`,
        ], { cwd, env: childEnv, timeoutMs: TIMEOUT_MS });
        try { bytes = await readFile(join(cwd, 'image.png')); }
        catch { throw new Error('Codex completed without saving an image.'); }
      } else {
        const output = await run('grok', [
          '--cwd', cwd, ...GROK_IMAGE_ARGS, '-p',
          `Call the built-in image_gen tool exactly once.${aspect_ratio ? ` Set the tool argument aspect_ratio=${JSON.stringify(aspect_ratio)}.` : ''} Do not read instructions, search for tools, or use other tools. Report the actual image file path from the tool result. The image description is: ${JSON.stringify(prompt)}`,
        ], { cwd, env: childEnv, timeoutMs: TIMEOUT_MS });
        let imagePath;
        for (const line of String(output || '').split('\n')) {
          try {
            const event = JSON.parse(line);
            for (const block of event.type === 'user' ? event.message?.content || [] : []) {
              if (block.type !== 'tool_result' || block.is_error) continue;
              const result = JSON.parse(block.content);
              if (result.type === 'ImageGen') imagePath = result.path;
            }
          } catch { /* Ignore unrelated stream events. */ }
        }
        if (!imagePath) throw new Error('Grok produced no image; check subscription image access and tool permissions.');
        let path;
        let sessionsDir;
        try {
          path = await realpath(imagePath);
          sessionsDir = await realpath(join(childEnv.HOME || homedir(), '.grok/sessions'));
        } catch { throw new Error('Grok produced no image file.'); }
        if (!path.startsWith(`${sessionsDir}/`) || !/\.(png|jpe?g|webp)$/i.test(path)) {
          throw new Error('Grok image path is outside the subscription image sessions directory.');
        }
        bytes = await readFile(path);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } else {
    let key;
    try {
      key = String(await readKey(env.IMAGE_GEN_PROXY_KEY_FILE || join(homedir(), '.dueno-fleet/cliproxyapi/local-api-key'), 'utf8')).trim();
    } catch { throw new Error('Google image generation needs the local CLIProxyAPI key file and Google login.'); }
    if (!key) throw new Error('The local CLIProxyAPI key file is empty.');
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:8317/v1beta/models/${GOOGLE_IMAGE_MODEL}:generateContent`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: size || '1K', ...(aspect_ratio ? { aspectRatio: aspect_ratio } : {}) } },
        }),
      });
    } catch { throw new Error('Google image generation could not reach local CLIProxyAPI or timed out.'); }
    if (!response.ok) throw new Error(`Google image generation failed (HTTP ${response.status}); check the proxy Google login and model availability.`);
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Google image generation returned an invalid response.'); }
    const part = result?.candidates?.flatMap((candidate) => candidate.content?.parts || []).find((part) => part.inlineData?.data);
    if (!part) throw new Error('Google image generation returned no image; check subscription model availability.');
    bytes = Buffer.from(part.inlineData.data, 'base64');
  }
  const [mimeType, extension] = imageType(bytes);
  const info = mimeType === 'image/png' ? pngInfo(bytes) : null;
  if (background === 'transparent' && !info?.alpha) {
    throw new Error('Codex returned an image without an alpha channel for background=transparent.');
  }
  // Verify PNG ratios; Codex only gets a prompt hint.
  if (aspect_ratio && (provider === 'openai' || mimeType === 'image/png')) {
    const [width, height] = aspect_ratio.split(':').map(Number);
    if (!info?.height || Math.abs(info.width / info.height / (width / height) - 1) > 0.02) {
      throw new Error(`${provider} did not return the requested aspect_ratio=${aspect_ratio}.`);
    }
  }
  const path = requestedPath || join(outputDir, `${provider}-${randomUUID()}.${extension}`);
  await mkdir(dirname(path), { recursive: true });
  if (outside(await realpath(outputDir), await realpath(dirname(path)))) {
    throw new Error('output_path must stay inside the generated-images directory.');
  }
  // Exclusive creation also rejects existing output-file symlinks.
  await writeFile(path, bytes, { flag: 'wx' });
  return { provider, path, mimeType, bytes: bytes.length };
}

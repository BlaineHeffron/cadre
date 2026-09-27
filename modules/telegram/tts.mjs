import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../../lib/exec.mjs';

const SESSION_TAG_RE = /^\[[^\]]{1,80}\]\s*/;
const PAGE_PREFIX_RE = /^\[\d+\/\d+\]\s*/;

export function cleanTextForSpeech(text = '') {
  return String(text || '')
    .replace(PAGE_PREFIX_RE, '')
    .replace(SESSION_TAG_RE, '')
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

let cachedDependencyCheck = null;

async function commandWorks(execImpl, cmd, args) {
  try {
    const result = await execImpl(cmd, args, { timeout: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function speechSynthesisAvailable({ execImpl = exec, force = false } = {}) {
  if (!force && cachedDependencyCheck !== null) return cachedDependencyCheck;
  const available = await Promise.all([
    commandWorks(execImpl, 'gtts-cli', ['--version']),
    commandWorks(execImpl, 'ffmpeg', ['-version']),
  ]);
  cachedDependencyCheck = available.every(Boolean);
  return cachedDependencyCheck;
}

export async function synthesizeSpeech(text, { execImpl = exec } = {}) {
  const speech = cleanTextForSpeech(text);
  if (!speech) throw new Error('no speakable text');
  const workDir = await mkdtemp(join(tmpdir(), 'telegram-tts-'));
  const txtPath = join(workDir, 'text.txt');
  const mp3Path = join(workDir, 'speech.mp3');
  const oggPath = join(workDir, 'speech.ogg');
  try {
    await writeFile(txtPath, speech, 'utf8');
    const tts = await execImpl('gtts-cli', ['-f', txtPath, '-o', mp3Path], { timeout: 60000 });
    if (tts.code !== 0) throw new Error(`gtts-cli failed: ${tts.stderr || tts.code}`);
    const convert = await execImpl('ffmpeg', [
      '-y',
      '-i',
      mp3Path,
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      oggPath,
    ], { timeout: 60000 });
    if (convert.code !== 0) throw new Error(`ffmpeg failed: ${convert.stderr || convert.code}`);
    return await readFile(oggPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

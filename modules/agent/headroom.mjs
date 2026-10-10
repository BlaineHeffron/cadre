import { fileURLToPath } from 'node:url';
import { getAgentProviderPreferences } from './provider-preferences.mjs';
import { shouldSuppressSideEffectLoops } from '../platform/side-effect-loops.mjs';
import { withCadreEnv } from '../platform/cadre-env.mjs';

export const HEADROOM_URL = 'http://127.0.0.1:8787';
const PI_EXTENSION = fileURLToPath(new URL('../integrations/pi-headroom-extension.mjs', import.meta.url));

export function headroomLaunchOverrides(provider, baseUrl = HEADROOM_URL) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Headroom must use an HTTP loopback origin (127.0.0.1)');
  }
  const origin = url.origin;
  if (provider === 'claude' || provider === 'anthropic') {
    // Prompt-suggestion side requests make Headroom re-send compressed history uncompressed on the next
    // turn, forcing a full prompt-cache rewrite; agent-driven sessions never use the suggestions.
    return { env: { ANTHROPIC_BASE_URL: origin, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' }, args: [] };
  }
  if (provider === 'codex' || provider === 'openai') {
    // Built-in provider IDs are reserved in current Codex. Keep OpenAI auth
    // and the upstream routing header on a Fleet-owned custom provider instead.
    return {
      modelProvider: 'dueno-headroom',
      env: { OPENAI_BASE_URL: `${origin}/v1` },
      args: ['-c', 'model_providers.dueno-headroom.name="OpenAI via Headroom"',
        '-c', `model_providers.dueno-headroom.base_url="${origin}/v1"`,
        '-c', 'model_providers.dueno-headroom.wire_api="responses"',
        '-c', 'model_providers.dueno-headroom.requires_openai_auth=true',
        '-c', 'model_providers.dueno-headroom.http_headers.x-headroom-base-url="https://api.openai.com"'],
    };
  }
  if (provider === 'deepseek') {
    // The Fleet proxy's default chat-completions upstream is DeepSeek. DSH has no header override.
    return { env: { DEEPSEEK_BASE_URL: `${origin}/v1` }, args: [] };
  }
  if (['xai', 'google', 'opencode-go', 'openrouter'].includes(provider)) {
    return { env: withCadreEnv({ DUENO_HEADROOM_URL: origin }), args: ['--extension', PI_EXTENSION] };
  }
  throw new TypeError(`Unsupported Headroom provider: ${provider}`);
}

export async function prepareHeadroomLaunch(provider, {
  env = process.env,
  preferences,
  baseUrl = HEADROOM_URL,
} = {}) {
  // Smoke/test servers never connect their agents to the production proxy.
  if (shouldSuppressSideEffectLoops({ env })) return { env: {}, args: [] };
  const prefs = preferences || await getAgentProviderPreferences();
  if (prefs.headroomEnabled === false) return { env: {}, args: [] };
  const launch = headroomLaunchOverrides(provider, baseUrl);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    const health = await response.json();
    if (!response.ok || health.service !== 'headroom-proxy' || health.ready !== true
      || health.version !== '0.37.0' || health.deployment?.profile !== 'dueno-fleet'
      || health.config?.openai_api_url !== 'https://api.deepseek.com') throw new Error();
  } catch {
    throw Object.assign(new Error('Headroom is unavailable. Start dueno-headroom.service or turn off Headroom in Settings.'), {
      statusCode: 503, code: 'headroom_unavailable',
    });
  }
  return launch;
}

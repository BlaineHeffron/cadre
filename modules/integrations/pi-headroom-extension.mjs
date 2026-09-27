import { readEnv } from '../platform/cadre-env.mjs';

// Pi providers can mix wire formats (OpenCode Go uses both Anthropic and OpenAI).
// Retain each model's upstream URL and wire format when redirecting it locally.
export function headroomPiModels(models, origin) {
  return models.map((model) => ({
    ...model,
    baseUrl: model.api === 'anthropic-messages' ? origin
      : model.api === 'google-generative-ai' ? `${origin}/v1beta` : `${origin}/v1`,
    headers: { ...model.headers, 'x-headroom-base-url': model.baseUrl.replace(/\/v1(?:beta)?\/?$/, '') },
  }));
}

export default function headroomPi(pi) {
  const origin = readEnv('DUENO_HEADROOM_URL');
  if (!origin) return;
  const redirect = async (_event, ctx) => {
    const model = ctx.model;
    if (!model || !['xai', 'google', 'opencode-go', 'openrouter'].includes(model.provider)) return;
    if (model.baseUrl === origin || model.baseUrl.startsWith(`${origin}/`)) return;
    // Change only the selected model's transport. The registry retains credentials,
    // custom headers, OAuth handlers, and the unmodified model-picker catalog.
    await pi.setModel(headroomPiModels([model], origin)[0]);
  };
  pi.on('session_start', redirect);
  pi.on('model_select', redirect);
}

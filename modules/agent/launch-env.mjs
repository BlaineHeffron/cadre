import { shellEscape } from '../platform/shell-quote.mjs';

/**
 * Codex has no `--session-id` flag, so we cannot choose its rollout uuid. It does record
 * `originator` in the rollout's `session_meta` (the first line of the file), and honours
 * `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`. Stamping the Dueno session id there gives codex the
 * same launch-time identity claude gets from `--session-id`, readable without reading the
 * rollout body. If a future codex drops the override, the stamp is simply absent and the
 * transcript resolver falls through to a weaker anchor rather than binding the wrong file.
 */
export function duenoOriginator(sessionId = '') {
  const id = String(sessionId || '').trim();
  return id ? `dueno-${id}` : '';
}

function isCodexProvider(provider = '') {
  const name = String(provider || '').trim().toLowerCase();
  return name === 'codex' || name === 'openai';
}

export function buildLaunchEnvPrefix(sessionId = '', provider = '', workDir = '') {
  const id = String(sessionId || '').trim();
  const providerName = String(provider || '').trim();
  const originator = isCodexProvider(providerName) ? duenoOriginator(id) : '';
  return [
    id ? `export CADRE_SESSION_ID=${shellEscape(id)}; export DUENO_SESSION_ID=${shellEscape(id)}` : '',
    providerName ? `export CADRE_PROVIDER=${shellEscape(providerName)}; export DUENO_PROVIDER=${shellEscape(providerName)}` : '',
    workDir ? `export CADRE_SESSION_WORK_DIR=${shellEscape(workDir)}; export DUENO_SESSION_WORK_DIR=${shellEscape(workDir)}` : '',
    originator ? `export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${shellEscape(originator)}` : '',
  ].filter(Boolean).join('; ');
}

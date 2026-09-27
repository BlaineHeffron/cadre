import { readEnv } from './cadre-env.mjs';

export function createBuildId(env = process.env, now = () => Date.now()) {
  return String(readEnv('DUENO_FLEET_BUILD_ID', env) || env.GIT_COMMIT || now().toString(36)).trim();
}

export function isRevalidatedStaticAsset(pathname = '') {
  return /\.(?:mjs|js|html)$/i.test(String(pathname || ''));
}

export function applyRevalidatedCacheHeader(res, pathname = '') {
  if (!isRevalidatedStaticAsset(pathname)) return;
  // @fastify/static v8 invoked setHeaders with the raw http.ServerResponse
  // (setHeader); v10 invokes it with the Fastify Reply (header). Support both
  // so a dependency bump cannot take down static asset serving.
  if (typeof res?.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  } else if (typeof res?.header === 'function') {
    res.header('Cache-Control', 'no-cache, must-revalidate');
  }
}

function looksProtectedApiOrWs(path = '') {
  return /^\/(?:api|ws)(?:\/|$)/i.test(path);
}

function normalizePathSegments(path = '') {
  const parts = [];
  for (const part of String(path || '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function decodeProtectedPathStep(path = '') {
  let next;
  try {
    next = decodeURIComponent(path);
  } catch {
    next = path.replace(/%25/gi, '%');
  }
  return next.replaceAll('\\', '/').replace(/%(?:2f|5c)/gi, '/');
}

export function isProtectedRoutePath(rawUrl = '') {
  let path = String(rawUrl || '/').split(/[?#]/, 1)[0].replaceAll('\\', '/');
  const maxDecodePasses = 16;

  for (let pass = 0; pass < maxDecodePasses; pass += 1) {
    if (looksProtectedApiOrWs(path) || looksProtectedApiOrWs(normalizePathSegments(path))) return true;
    const decoded = decodeProtectedPathStep(path);
    if (decoded === path) break;
    path = decoded;
  }

  return looksProtectedApiOrWs(path) || looksProtectedApiOrWs(normalizePathSegments(path));
}

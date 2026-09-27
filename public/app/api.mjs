const BASE = '/api';
const EXPECTED_API_ERROR_CODES = new Set([
  'approval_required',
  'action_blocked_by_policy',
]);

function shouldLogApiError(statusCode, errorCode = '') {
  return !(statusCode === 409 && EXPECTED_API_ERROR_CODES.has(String(errorCode || '').trim()));
}

async function request(method, path, body = null) {
  const headers = {};

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error(`API request error:`, e);
    throw new Error(`Network error: ${e.message}`);
  }

  if (!res.ok) {
    let err;
    try {
      err = await res.json();
    } catch (e) {
      console.error(`API error response not JSON [${res.status}]:`, res.statusText);
      err = { error: res.statusText };
    }
    const errorMsg = err.error || err.message || `HTTP ${res.status}: ${res.statusText}`;
    if (shouldLogApiError(res.status, err.code)) {
      console.error(`API ${method} ${path} failed [${res.status}]: ${errorMsg}`);
    }
    const wrapped = new Error(errorMsg);
    wrapped.statusCode = res.status;
    wrapped.code = err.code || '';
    wrapped.approval = err.approval || null;
    wrapped.policy = err.policy || null;
    wrapped.preview = err.preview || null;
    wrapped.freshSession = err.freshSession || null;
    throw wrapped;
  }

  return res.json();
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  delete: (path) => request('DELETE', path),
};

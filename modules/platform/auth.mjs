/**
 * Auth plugin — verifies Bearer token on /api/* routes.
 * Includes per-IP failure tracking with temporary lockout.
 *
 * Register on the Fastify instance:
 *   await app.register(authPlugin);
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.mjs';
import { isProtectedRoutePath } from './static-cache.mjs';
import { queueControlEvent } from '../ops/control-events.mjs';
import {
  AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER,
  consumeAgentBusMcpInProcessRequestContext,
  currentAgentBusMcpAuthContext,
} from '../agent-bus/mcp-auth.mjs';

const AUTH_MAX_FAILURES = 10;
const AUTH_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
export const BROWSER_SESSION_COOKIE = 'dueno_session';
const authFailures = new Map(); // ip → { count, firstFailure }
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_CODE_MAX = 5;
const pairCodes = new Map(); // single-use phone pairing code → expiresAt (ms)

function isLockedOut(ip) {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstFailure > AUTH_LOCKOUT_MS) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_FAILURES;
}

function recordFailure(ip) {
  const entry = authFailures.get(ip);
  if (!entry || Date.now() - entry.firstFailure > AUTH_LOCKOUT_MS) {
    authFailures.set(ip, { count: 1, firstFailure: Date.now() });
  } else {
    entry.count++;
  }
}

function clearFailures(ip) {
  authFailures.delete(ip);
}

export function isTrustedInternalIp(ip = '') {
  const normalized = String(ip || '').trim();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === 'localhost';
}

function constantTimeMatch(left, right) {
  if (!left || !right) return false;
  try {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Burns and returns true for a live matching code; always prunes expired codes.
function takePairCode(supplied, nowMs = Date.now()) {
  let matched = false;
  for (const [code, expiresAt] of pairCodes) {
    if (nowMs > expiresAt) pairCodes.delete(code);
    else if (!matched && constantTimeMatch(supplied, code)) {
      pairCodes.delete(code);
      matched = true;
    }
  }
  return matched;
}

export function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const eqIndex = part.indexOf('=');
      if (eqIndex <= 0) return cookies;
      const key = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();
      cookies[key] = (() => { try { return decodeURIComponent(value); } catch { return ''; } })();
      return cookies;
    }, {});
}

function currentAuthToken() {
  return config.auth.token || process.env.AUTH_TOKEN || '';
}

function currentInternalBypassToken() {
  return config.auth.internalBypassToken || process.env.INTERNAL_BYPASS_TOKEN || '';
}

function currentBrowserSessionSecret() {
  return config.auth.browserSessionSecret || process.env.BROWSER_SESSION_SECRET || '';
}

const PUBLIC_API_ROUTES = new Set([
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
]);

export function trustProxyHop(address, hop) {
  return Number(hop) === 0 && isTrustedInternalIp(address);
}

function isPublicRoutedApiPath(routedPath = '') {
  const routed = String(routedPath || '');
  if (PUBLIC_API_ROUTES.has(routed)) return true;
  return routed === '/api/research' || routed.startsWith('/api/research/');
}

function shouldProtectApiRequest(request) {
  const routed = request.routeOptions?.url || '';
  if (isPublicRoutedApiPath(routed)) return false;
  if (routed === '/api' || routed.startsWith('/api/')) return true;
  if (!routed) return isProtectedRoutePath(request.raw?.url || request.url);
  return false;
}

function base64UrlEncodeJson(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function signBrowserSessionPayload(encodedPayload, secret = currentBrowserSessionSecret()) {
  if (!encodedPayload || !secret) return '';
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createBrowserSessionCookieValue({
  nowMs = Date.now(),
  ttlMs = config.auth.browserSessionTtlMs,
  secret = currentBrowserSessionSecret(),
} = {}) {
  const maxTtl = Math.max(1000, Number(ttlMs) || 0);
  const payload = base64UrlEncodeJson({
    v: 1,
    iat: nowMs,
    exp: nowMs + maxTtl,
    nonce: randomBytes(16).toString('base64url'),
  });
  const sig = signBrowserSessionPayload(payload, secret);
  if (!sig) return '';
  return `${payload}.${sig}`;
}

export function verifyBrowserSessionCookie(value, {
  nowMs = Date.now(),
  secret = currentBrowserSessionSecret(),
} = {}) {
  if (!value || !secret || !String(value).includes('.')) return false;
  const [payload, sig, extra] = String(value).split('.');
  if (!payload || !sig || extra !== undefined) return false;
  const expected = signBrowserSessionPayload(payload, secret);
  if (!constantTimeMatch(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data?.v === 1 && Number.isFinite(data.exp) && nowMs <= data.exp;
  } catch {
    return false;
  }
}

export function verifyBrowserSessionRequest(request) {
  const cookies = parseCookies(request.headers?.cookie || '');
  return verifyBrowserSessionCookie(cookies[BROWSER_SESSION_COOKIE]);
}

function cookieSecureAttribute(request) {
  const proto = request.headers?.['x-forwarded-proto'];
  const encrypted = request.raw?.socket?.encrypted;
  return encrypted || proto === 'https' || config.tlsEnabled ? '; Secure' : '';
}

function browserSessionSetCookie(value, request, { maxAgeSec } = {}) {
  const maxAge = Number.isFinite(Number(maxAgeSec)) ? `; Max-Age=${Math.max(0, Math.floor(Number(maxAgeSec)))}` : '';
  return `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(value || '')}; Path=/; HttpOnly; SameSite=Lax${maxAge}${cookieSecureAttribute(request)}`;
}

function expiredCookie(request, name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cookieSecureAttribute(request)}`;
}

export function buildInternalBypassHeaders({
  authToken = currentAuthToken(),
  bypassToken = currentInternalBypassToken(),
  now = new Date(),
  automationPolicy = '',
} = {}) {
  const headers = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (bypassToken) headers['x-dueno-internal'] = bypassToken;
  headers['x-dueno-internal-ts'] = now.toISOString();
  if (automationPolicy) headers['x-dueno-automation-policy'] = String(automationPolicy);
  return headers;
}

export function permissionAuthorityForRequest(request, {
  tool = '',
  scope = 'permission.approve',
  risk = 'provider_tool_execution',
} = {}) {
  const auth = request?.duenoAuth || null;
  const principal = auth?.principal || null;
  const policy = String(auth?.automationPolicy || '').trim();
  const automationApproved = principal?.type === 'service'
    && policy
    && config.permissionAuthority.preapprovedAutomationPolicies.includes(policy);
  const operatorApproved = auth?.authenticated === true && principal?.type === 'ui';
  const decision = operatorApproved || automationApproved ? 'allowed' : 'denied';
  const audit = {
    actor: principal ? `${principal.kind}:${principal.sessionId}` : 'unauthenticated',
    principalType: principal?.type || 'unknown',
    policy: operatorApproved ? 'authenticated_operator' : (policy || 'none'),
    tool: String(tool || ''),
    scope: String(scope || ''),
    risk: String(risk || ''),
    decision,
  };
  if (decision === 'denied') {
    const error = new Error('Permission interactions require an authenticated operator or a pre-approved automation policy');
    error.statusCode = 403;
    error.code = 'permission_authority_required';
    error.authorityAudit = audit;
    throw error;
  }
  return audit;
}

export function evaluateInternalBypass(request, {
  authToken = currentAuthToken(),
  bypassToken = currentInternalBypassToken(),
  bypassTtlMs = config.auth.internalBypassTtlMs,
  nowMs = Date.now(),
} = {}) {
  const ip = request.ip || '';
  const internalHeader = request.headers['x-dueno-internal'];
  const tsHeader = request.headers['x-dueno-internal-ts'];
  if (!internalHeader) return { allowed: false, reason: 'missing_header', ip };
  if (request.headers['x-forwarded-for'] || request.headers.forwarded) {
    return { allowed: false, reason: 'forwarded_request', ip };
  }
  if (!isTrustedInternalIp(ip)) return { allowed: false, reason: 'untrusted_ip', ip };
  if (authToken && bypassToken && constantTimeMatch(bypassToken, authToken)) {
    return { allowed: false, reason: 'shared_secret', ip };
  }
  if (typeof internalHeader !== 'string' || !constantTimeMatch(internalHeader, bypassToken)) {
    return { allowed: false, reason: 'invalid_secret', ip };
  }
  if (!authToken) return { allowed: false, reason: 'auth_not_configured', ip };
  if (typeof tsHeader !== 'string' || !tsHeader.trim()) {
    return { allowed: false, reason: 'missing_timestamp', ip };
  }
  const tsMs = Date.parse(tsHeader);
  if (!Number.isFinite(tsMs)) return { allowed: false, reason: 'invalid_timestamp', ip };
  const ageMs = Math.abs(nowMs - tsMs);
  if (ageMs > Math.max(1000, Number(bypassTtlMs) || 0)) {
    return { allowed: false, reason: 'expired_timestamp', ip, ageMs };
  }
  return { allowed: true, reason: 'ok', ip, ageMs };
}

function authPluginImpl(app, opts = {}, done) {
  const authToken = opts.token || currentAuthToken();
  const internalBypassToken = opts.internalBypassToken || currentInternalBypassToken();
  const internalBypassTtlMs = opts.internalBypassTtlMs || config.auth.internalBypassTtlMs;
  const browserSessionTtlMs = opts.browserSessionTtlMs || config.auth.browserSessionTtlMs;

  app.post('/api/auth/login', async (request, reply) => {
    const suppliedToken = typeof request.body?.token === 'string' ? request.body.token : '';
    const pairCode = typeof request.body?.pairCode === 'string' ? request.body.pairCode : '';
    const ip = request.ip;
    if (isLockedOut(ip)) {
      request.log.warn(`Auth lockout active for ${ip}`);
      return reply.code(429).send({ error: 'Too many failed attempts. Try again later.' });
    }
    if (!authToken) {
      request.log.warn('AUTH_TOKEN not configured — browser login rejected');
      return reply.code(500).send({ error: 'Server auth not configured' });
    }
    if (!(pairCode ? takePairCode(pairCode) : constantTimeMatch(suppliedToken, authToken))) {
      recordFailure(ip);
      request.log.warn(`Browser auth failure from ${ip} (${authFailures.get(ip)?.count || 1}/${AUTH_MAX_FAILURES})`);
      return reply.code(403).send({ error: pairCode ? 'Invalid or expired pairing code' : 'Invalid token' });
    }
    if (pairCode) request.log.info(`Browser session paired via pairing code from ${ip}`);
    clearFailures(ip);
    const session = createBrowserSessionCookieValue({ ttlMs: browserSessionTtlMs });
    if (!session) return reply.code(500).send({ error: 'Server auth not configured' });
    reply.header('Set-Cookie', [
      browserSessionSetCookie(session, request, { maxAgeSec: browserSessionTtlMs / 1000 }),
      expiredCookie(request, 'dueno_token'),
    ]);
    return { authenticated: true };
  });

  // Operator-only: mint a short-lived, single-use code for signing in another device.
  // The client puts it in a URL fragment (#pair=) so it never reaches server logs.
  app.post('/api/auth/pair', async (request, reply) => {
    if (request.duenoAuth?.principal?.type !== 'ui') {
      return reply.code(403).send({ error: 'Pairing requires an authenticated operator' });
    }
    const nowMs = Date.now();
    takePairCode('', nowMs);
    while (pairCodes.size >= PAIR_CODE_MAX) pairCodes.delete(pairCodes.keys().next().value);
    const code = randomBytes(24).toString('base64url');
    pairCodes.set(code, nowMs + PAIR_CODE_TTL_MS);
    request.log.info(`Browser pairing code issued to ${request.ip}`);
    reply.header('Cache-Control', 'no-store');
    return { code, expiresAt: new Date(nowMs + PAIR_CODE_TTL_MS).toISOString() };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Set-Cookie', [
      expiredCookie(request, BROWSER_SESSION_COOKIE),
      expiredCookie(request, 'dueno_token'),
    ]);
    return { authenticated: false };
  });

  app.get('/api/auth/status', async (request) => ({
    authenticated: verifyBrowserSessionRequest(request),
  }));

  // Use onRequest hook which runs before routing. Classify the routed path so
  // encoded /api prefixes and dot-segments cannot skip auth or match a public exemption.
  app.addHook('onRequest', async function authHook(request, reply) {
    const path = request.routeOptions?.url || request.url;
    if (!shouldProtectApiRequest(request)) return;

    const bypass = evaluateInternalBypass(request, {
      authToken,
      bypassToken: internalBypassToken,
      bypassTtlMs: internalBypassTtlMs,
    });
    if (request.headers['x-dueno-mcp-principal'] || request.headers['x-dueno-mcp-auth-context']) {
      return reply.code(400).send({ error: 'Client-supplied MCP principal headers are forbidden' });
    }
    if (request.headers['x-dueno-internal']) {
      queueControlEvent({
        type: 'internal_bypass',
        severity: bypass.allowed ? 'warning' : 'critical',
        module: 'auth',
        action: 'internal_bypass',
        outcome: bypass.allowed ? 'accepted' : 'rejected',
        code: bypass.allowed ? 'auth.internal_bypass_accepted' : `auth.internal_bypass_${bypass.reason}`,
        detail: path,
        message: bypass.allowed ? 'Internal bypass accepted' : 'Internal bypass rejected',
        metadata: {
          ip: bypass.ip,
          reason: bypass.reason,
          ageMs: Number.isFinite(Number(bypass.ageMs)) ? Number(bypass.ageMs) : null,
        },
      }, (error) => request.log.warn({ err: error }, 'Failed to persist internal bypass control event'));
    }
    if (request.headers[AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER] && !bypass.allowed) {
      return reply.code(403).send({ error: 'In-process MCP request context requires a valid internal bypass' });
    }
    if (bypass.allowed) {
      const contextId = request.headers[AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER];
      const mcpAuth = contextId
        ? consumeAgentBusMcpInProcessRequestContext(contextId)
        : currentAgentBusMcpAuthContext();
      if (contextId && !mcpAuth) {
        return reply.code(403).send({ error: 'Invalid or expired in-process MCP request context' });
      }
      const automationPolicy = String(request.headers['x-dueno-automation-policy'] || '').trim();
      request.duenoAuth = {
        authenticated: mcpAuth ? mcpAuth.authenticated === true : true,
        legacyUntrusted: mcpAuth ? mcpAuth.legacyUntrusted === true : false,
        principal: mcpAuth?.principal || { type: 'service', kind: 'service', sessionId: 'internal' },
        toolScopes: mcpAuth?.toolScopes || [],
        threadAllowlist: mcpAuth?.threadAllowlist || [],
        taskRoomRead: mcpAuth?.taskRoomRead === true,
        coordinatorPolicy: mcpAuth?.coordinatorPolicy || null,
        loopRegistrationPolicy: mcpAuth?.loopRegistrationPolicy || null,
        automationPolicy: mcpAuth ? '' : automationPolicy,
        source: mcpAuth ? 'agent_bus_mcp' : 'internal',
      };
      request.log.info({
        control_event: {
          type: 'internal_bypass_used',
          path,
          ip: bypass.ip,
          ageMs: bypass.ageMs,
        },
      }, 'Internal bypass accepted');
      return;
    }

    const ip = request.ip;

    // Check lockout before even parsing the token
    if (isLockedOut(ip)) {
      request.log.warn(`Auth lockout active for ${ip}`);
      return reply.code(429).send({ error: 'Too many failed attempts. Try again later.' });
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (verifyBrowserSessionRequest(request)) {
        clearFailures(ip);
        request.duenoAuth = {
          authenticated: true,
          principal: { type: 'ui', kind: 'dashboard', sessionId: 'browser' },
          automationPolicy: '',
        };
        return;
      }
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    if (!authToken) {
      request.log.warn('AUTH_TOKEN not configured — all requests rejected');
      return reply.code(500).send({ error: 'Server auth not configured' });
    }

    // Constant-time comparison
    const a = Buffer.from(token);
    const b = Buffer.from(authToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      recordFailure(ip);
      request.log.warn(`Auth failure from ${ip} (${authFailures.get(ip)?.count || 1}/${AUTH_MAX_FAILURES})`);
      return reply.code(403).send({ error: 'Invalid token' });
    }

    clearFailures(ip);
    request.duenoAuth = {
      authenticated: true,
      principal: { type: 'ui', kind: 'operator', sessionId: 'bearer' },
      automationPolicy: '',
    };
  });

  done();
}

// Mark as non-encapsulated to apply to parent scope
authPluginImpl[Symbol.for('skip-override')] = true;

export const authPlugin = authPluginImpl;

/**
 * Verify a token string for WebSocket upgrade authentication.
 * @param {string} token
 * @returns {boolean}
 */
export function verifyToken(token) {
  return constantTimeMatch(token, config.auth.token);
}

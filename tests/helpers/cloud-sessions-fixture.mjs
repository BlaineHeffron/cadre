import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Cloud-session fixtures: CLI credential files, a fake API server, a fake `gh`, and session rows.
export const ACCESS = 'access-secret-1';
export const REFRESHED = 'access-secret-2';

export async function fixture(t, { expiresAt = Date.now() + 3600000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-cloud-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeDir = join(dir, '.claude');
  await mkdir(claudeDir);
  await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify({
    other: 'kept',
    claudeAiOauth: { accessToken: ACCESS, refreshToken: 'refresh-secret-1', expiresAt, scopes: ['user:inference', 'user:sessions:claude_code'] },
  }));
  const claudeJsonPath = join(dir, '.claude.json');
  await writeFile(claudeJsonPath, JSON.stringify({ oauthAccount: { organizationUuid: 'org-1' } }));

  const requests = [];
  const events = [];
  const routes = {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const route = routes[`${req.method} ${url.pathname}`];
    const [status, payload] = route ? await route(url, body) : [404, { error: 'nope' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ghLog = join(dir, 'gh.log');
  const ghBin = join(dir, 'gh');
  await writeFile(ghBin, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const branch = process.argv[process.argv.indexOf('--head') + 1];
const prs = { 'claude/has-pr': [7, 'OPEN'], 'claude/new-pr': [9, 'OPEN'], 'claude/old-pr': [3, 'MERGED'] };
const [number, state] = prs[branch] || [];
process.stdout.write(JSON.stringify(number ? [{ number, url: 'https://github.com/o/r/pull/' + number, state }] : []));
`);
  await chmod(ghBin, 0o755);

  return { dir, claudeDir, requests, events, routes, ghLog, opts: { baseUrl, claudeDir, claudeJsonPath, ghBin, pollMs: 10, rereadMs: 10 } };
}

export function eventsRoute(events) {
  return (url) => {
    const desc = url.searchParams.get('sort_order') === 'desc';
    const cursor = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : null;
    const limit = Number(url.searchParams.get('limit') || 50);
    let rows = events.filter((e) => cursor === null || (desc ? Number(e.sequence_num) < cursor : Number(e.sequence_num) > cursor));
    if (desc) rows = rows.slice().reverse();
    rows = rows.slice(0, limit);
    return [200, { data: rows, next_cursor: rows.at(-1)?.sequence_num ?? null }];
  };
}

export const cloudSession = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  environment_kind: 'anthropic_cloud',
  status: 'active',
  worker_status: 'idle',
  status_bucket: 'completed',
  session_url: `https://claude.ai/code/cshk_${id}`,
  config: { outcomes: [{ type: 'git_repository', git_info: { repo: 'o/r', branches: ['claude/outcome'] } }] },
  external_metadata: { current_branches: { '': 'claude/has-pr' }, usage: { cost_usd: 1.5 }, post_turn_summary: { status_detail: 'PR opened', needs_action: '' } },
  ...extra,
});

export function memoryStore() {
  let data = null;
  return { load: async () => structuredClone(data), save: async (next) => { data = structuredClone(next); } };
}


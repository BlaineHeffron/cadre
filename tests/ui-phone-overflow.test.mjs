// The real app at a 320px phone width in headless Chromium against a stubbed API full of long
// URLs, paths and IDs: no page scrolls sideways.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const url = `https://github.com/acme/repo/pull/123456789/files#diff-${'0123456789abcdef'.repeat(4)}`;
const path = '/home/operator/.worktrees/feature-a-really-long-branch-name/modules/deeply/nested';
const longFile = `an_extremely_long_file_name_${'x'.repeat(60)}.json`;
const id = 'abcdef0123456789'.repeat(2);
const session = (sid) => ({ id: sid, displayName: `Task ${sid}`, workDir: path, tmuxSession: `claude-${sid}`, state: { status: 'blocked', interaction: { kind: 'permission', detail: `Run command: ${url}` } } });

test('at 320px no page scrolls sideways, even with long URLs, paths and IDs', { skip: !process.env.CHROMIUM_BIN, timeout: 60000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/', index: false, wildcard: false });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  const stubs = {
    '/api/auth/status': { authenticated: true },
    '/api/command-center/work-queue': { openCount: 1, items: [{ id: 'q1', status: 'open', title: `Approve ${url}`, question: `Edit ${path}/file.mjs?`, details: url, createdAt: new Date().toISOString(), allowFreeform: true }] },
    '/api/claude/sessions': { sessions: [session('a1')] },
    '/api/claude/sessions/a1': { ...session('a1'), content: `● Read(${path}/${longFile})`, sessionName: 'claude-a1' },
    '/api/fleet/deployments': { deployments: [{ deploymentId: `dep-${id}`, displayName: `Deploy ${url}`, latestSnapshot: { status: 'degraded', reachable: true, markers: [`marker:${url}`] } }] },
    '/api/fleet/incidents': { incidents: [{ id: 'i1', deploymentId: `dep-${id}${id}`, status: 'open', occurrenceCount: 1, openedAtMs: Date.now(), markers: [url] }] },
    '/api/agents/github': { enabled: true, repos: [{ id: 'r1', owner: 'acme', repo: `repo-${id}`, enabled: true, lastError: `HTTP 502 from ${url}` }] },
    '/api/skills': { skills: [{ id: 's1', name: `skill-${id}`, description: `Uses ${url}`, preview: url, source: 'local' }] },
    '/api/recordings': { total: 1, hasMore: false, recordings: [{ id: 'rec1', stem: `meeting_${id}${id}`, capturedAtMs: Date.now(), tags: [url] }] },
    '/api/machines': { machines: [{ id: `machine-${id}`, label: 'box', status: 'live' }] },
    '/api/threats/alerts': { alerts: [] },
    '/api/files/info': { path: longFile, name: longFile, type: 'file', size: 2, sizeFormatted: '2 B', isText: true, extension: '.json' },
    '/api/files/read': { content: '{}', path: longFile },
  };
  app.get('/api/*', (req) => stubs[req.url.split('?')[0]] || { sessions: [], tasks: [], threads: [], items: [] });
  app.get('/*', (_req, reply) => reply.type('text/html').send(index));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
  page.setDefaultTimeout(5000);

  const pages = {
    '/queue': `Approve ${url}`,
    '/fleet': `Deploy ${url}`,
    '/github-agents': `HTTP 502 from ${url}`,
    '/agents': `Run command: ${url}`,
    '/claude/a1': `Run command: ${url}`,
    '/skills': `Uses ${url}`,
    '/recordings': `meeting_${id}${id}`,
    '/settings': `machine-${id}`,
    '/threats': 'Threat Alerts',
    [`/files?path=${longFile}`]: longFile,
  };
  const tooWide = {};
  for (const [route, text] of Object.entries(pages)) {
    await page.goto(`${origin}${route}`);
    await page.getByText(text).first().waitFor();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (width > 320) tooWide[route] = width;
  }
  assert.deepEqual(tooWide, {});
});

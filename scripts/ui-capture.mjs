#!/usr/bin/env node
// Captures the eight UI/UX scoring screenshots of the current checkout:
//   CHROMIUM_BIN=/path/to/chromium node scripts/ui-capture.mjs <out-dir>
// Starts this checkout's real server on free ports with side effects off and a
// throwaway HOME/state dir, then serves hermetic demo sessions to the browser
// from the network layer (live sessions need real agent processes). Session
// states come from the real pane detector, and the browser clock is pinned, so
// two runs on one commit give the same pixels.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';
import { projectCompatibility } from '../modules/session-state/contract.mjs';
import { observeClaudePane } from '../modules/session-state/providers/claude.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.UTC(2026, 10, 3, 15, 0, 0);
const WORKDIR = '/home/dev/projects/acme-notes';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const ansi = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const dim = (text) => ansi('38;5;246', text);
const rule = ansi('38;5;244', '─'.repeat(110));
const composer = (mode = 'accept edits on') => [rule, '❯ ', rule, `  ${ansi('95', `⏵⏵ ${mode}`)}${dim(' (shift+tab to cycle)')}`].join('\n');
const tool = (name, args, ...result) => [`${ansi('32', '●')} ${ansi('1', name)}(${args})`, ...result.map((line, i) => `  ${i ? '   ' : dim('⎿ ')} ${line}`)].join('\n');
const add = (n, text) => ansi('48;2;34;92;43', `       ${n} + ${text.padEnd(70)}`);
const del = (n, text) => ansi('48;2;122;41;54', `       ${n} - ${text.padEnd(70)}`);
const ctx = (n, text) => `       ${n}   ${text}`;

const CONVERSATION = [
  '❯ Add cursor pagination to GET /notes and cover it with tests',
  '',
  `${ansi('37', '●')} I'll read the current list handler and its tests first.`,
  '',
  tool('Read', 'src/routes/notes.ts', 'Read 84 lines'),
  '',
  tool('Search', 'pattern: "listNotes", path: "src"', 'Found 3 files'),
  '',
  tool('Update', 'src/routes/notes.ts', 'Updated src/routes/notes.ts with 12 additions and 3 removals'),
  '',
  tool('Bash', 'npm test -- notes', `${ansi('42;30', ' PASS ')} tests/notes.test.ts`, `  ${ansi('32', '✓')} returns the first page (12 ms)`, `  ${ansi('32', '✓')} returns a cursor for the next page (4 ms)`, `  ${ansi('32', '✓')} rejects a limit above 100 (3 ms)`, 'Tests: 3 passed, 3 total'),
  '',
  `${ansi('37', '●')} Pagination is in place. \`GET /notes\` now accepts \`limit\` (default 20, max 100)`,
  '  and an opaque `cursor`, and returns `nextCursor` when more notes remain. The three new',
  '  tests pass; the existing suite is unchanged.',
  '',
  `${ansi('37', '✻')} ${ansi('37', 'Cooked for 41s')}`,
  '',
  composer(),
].join('\n');

const DIFF = [
  '❯ The sync worker retries forever on a 4xx. Stop retrying client errors.',
  '',
  tool('Read', 'src/sync/worker.ts', 'Read 132 lines'),
  '',
  tool('Update', 'src/sync/worker.ts', 'Updated src/sync/worker.ts with 6 additions and 2 removals'),
  ctx(41, 'async function pushBatch(batch: Note[]) {'),
  ctx(42, '  const res = await client.post("/sync", batch);'),
  del(43, 'if (!res.ok) {'),
  del(44, '  return scheduleRetry(batch);'),
  add(43, 'if (res.status >= 400 && res.status < 500) {'),
  add(44, '  log.warn("sync rejected", { status: res.status });'),
  add(45, '  return markFailed(batch, res.status);'),
  add(46, '}'),
  add(47, 'if (!res.ok) {'),
  add(48, '  return scheduleRetry(batch);'),
  ctx(49, '  }'),
  ctx(50, '  return markSynced(batch);'),
  ctx(51, '}'),
  '',
  tool('Bash', 'npm test -- sync', `${ansi('42;30', ' PASS ')} tests/sync.test.ts`, 'Tests: 9 passed, 9 total'),
  '',
  `${ansi('37', '●')} Client errors now mark the batch failed instead of retrying; 5xx and network`,
  '  errors still back off and retry.',
  '',
  `${ansi('37', '✻')} ${ansi('37', 'Cooked for 18s')}`,
  '',
  composer(),
].join('\n');

const APPROVAL = [
  '❯ Run the settings migration against the local database',
  '',
  `${ansi('37', '●')} ${ansi('1', 'Bash')}(npm run migrate -- --target local)`,
  dim('  ⎿  Waiting…'),
  '',
  rule,
  ` ${ansi('1;38;5;153', 'Bash command')}`,
  '',
  '   npm run migrate -- --target local',
  dim('   Apply pending settings migrations to the local database'),
  '',
  ' Do you want to proceed?',
  ` ${ansi('38;5;153', '❯')} ${dim('1.')} ${ansi('38;5;153', 'Yes')}`,
  `   ${dim('2.')} Yes, and don't ask again for ${ansi('1', 'npm run migrate')} commands in this project`,
  `   ${dim('3.')} No, and tell Claude what to do differently ${dim('(esc)')}`,
].join('\n');

const WORKING = [
  '❯ Write an onboarding guide for new contributors in docs/',
  '',
  tool('Read', 'README.md', 'Read 61 lines'),
  '',
  tool('Write', 'docs/onboarding.md', 'Wrote 48 lines to docs/onboarding.md'),
  '',
  `${ansi('38;5;174', '✶')} ${ansi('38;5;174', 'Drafting… (52s · ↓ 2.4k tokens · esc to interrupt)')}`,
  '',
  composer(),
].join('\n');

const SESSIONS = [
  { id: 'a1f3', displayName: 'Settings migration', minutesAgo: 6, pane: APPROVAL },
  { id: 'b7c2', displayName: 'Notes API pagination', minutesAgo: 22, pane: CONVERSATION },
  { id: 'c9d4', displayName: 'Onboarding guide', minutesAgo: 35, pane: WORKING },
  { id: 'd2e8', displayName: 'Sync worker retries', minutesAgo: 58, pane: DIFF },
];

function buildSessions() {
  const tracker = createSessionStateTracker({ now: () => NOW });
  return SESSIONS.map(({ id, displayName, minutesAgo, pane }) => {
    const key = `claude:${id}`;
    const lifecycle = { source: 'process', kind: 'lifecycle', value: { lifecycle: 'running' }, observedAt: NOW, expiresAt: 0, fingerprint: 'process' };
    const state = projectCompatibility(tracker.observe(key, [lifecycle, ...observeClaudePane(pane, { observedAt: NOW, expiresAt: 0 })]));
    const created = Math.floor((NOW - minutesAgo * 60_000) / 1000);
    const session = { id, name: id, displayName, created, workDir: WORKDIR, model: 'claude-opus-5-5', provider: 'claude', runtime: 'claude', source: 'dashboard', tmuxSession: `cadre-${id}`, state };
    return { session, detail: { ...session, sessionName: session.tmuxSession, content: pane, lines: pane.split('\n').length } };
  });
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function startServer(scratch) {
  const [port, mcpPort] = [await freePort(), await freePort()];
  await mkdir(join(scratch, 'home'), { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: join(scratch, 'home'), TZ: 'UTC', LANG: 'C.UTF-8',
    PORT: String(port), AGENT_BUS_MCP_HTTP_PORT: String(mcpPort), CADRE_STATE_DIR: join(scratch, 'state'),
    AUTH_TOKEN: 'capture-auth', INTERNAL_BYPASS_TOKEN: 'capture-bypass', BROWSER_SESSION_SECRET: 'capture-session',
    TMUX_TMPDIR: join(scratch, 'tmux'), RESEARCH_WORKBENCH_FLEET_TOKEN_FILE: join(scratch, 'rw-token'),
    // dotenv never overrides set vars, so a checkout .env cannot re-allow side effects.
    CADRE_ALLOW_SIDE_EFFECTS: '0', CADRE_DISABLE_SIDE_EFFECTS: '1', CADRE_GITHUB_AGENT_POLLER_ENABLED: '0', CADRE_GITHUB_AGENTS_ENABLED: '0',
    CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0', TELEGRAM_BRIDGE: '0',
  };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-4000); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120 && child.exitCode === null; i += 1) {
    if (await fetch(`${origin}/api/auth/status`).then((r) => r.ok, () => false)) return { child, origin };
    await new Promise((done) => setTimeout(done, 250));
  }
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}

async function newPage(browser, origin, sessions, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' });
  await context.clock.setFixedTime(NOW);
  const login = await context.request.post(`${origin}/api/auth/login`, { data: { token: 'capture-auth' } });
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
  const byId = new Map(sessions.map((entry) => [entry.session.id, entry.detail]));
  await context.route(/\/api\/(claude|codex|pi|deepseek)\/sessions(\/|\?|$)/, (route) => {
    const { pathname } = new URL(route.request().url());
    const [, kind, , id, sub] = pathname.split('/').slice(1);
    const list = kind === 'claude' ? sessions.map((entry) => entry.session) : [];
    if (!id) return route.fulfill({ json: { sessions: list } });
    if (sub === 'transcript') return route.fulfill({ json: { text: '', messages: [] } });
    const detail = kind === 'claude' && byId.get(id);
    return detail && !sub ? route.fulfill({ json: detail }) : route.fulfill({ status: 404, json: { error: 'not found' } });
  });
  // Keep the real socket, but drop the server's (empty) live session pushes.
  await context.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const channel = String(JSON.parse(message).channel || '');
      if (!/^(claude|codex|pi|deepseek):/.test(channel)) ws.send(message);
    });
  });
  return context.newPage();
}

async function shoot(page, origin, path, file, ready) {
  await page.goto(`${origin}${path}`);
  await page.waitForLoadState('networkidle');
  if (ready) await ready(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
}

const outDir = process.argv[2] && resolve(process.argv[2]);
if (!outDir || !process.env.CHROMIUM_BIN) {
  console.error('usage: CHROMIUM_BIN=<chromium> node scripts/ui-capture.mjs <out-dir>');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'cadre-ui-capture-'));
let server;
let browser;
try {
  server = await startServer(scratch);
  const { origin } = server;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN,
    headless: true,
    // Software raster with fixed hinting and colour profile keeps reruns pixel-identical.
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--disable-partial-raster', '--disable-skia-runtime-opts'],
  });
  const sessions = buildSessions();
  const out = (name) => join(outDir, name);
  const text = (value) => (page) => page.getByText(value).first().waitFor();
  const desktop = await newPage(browser, origin, sessions, DESKTOP);
  await shoot(desktop, origin, '/agents', out('01-home.png'), text('Apply pending settings migrations'));
  await shoot(desktop, origin, '/claude/b7c2', out('02-conversation.png'), text('Pagination is in place'));
  await shoot(desktop, origin, '/claude/d2e8', out('03-diff.png'), text('markFailed'));
  await shoot(desktop, origin, '/claude/a1f3', out('04-approval.png'), text('Apply pending settings migrations'));
  await shoot(desktop, origin, '/agents', out('05-new-session.png'), async (page) => {
    await text('Sync worker retries')(page);
    const catalog = page.waitForResponse(/\/api\/agents\/mcp-servers/);
    await page.getByRole('button', { name: 'New', exact: true }).first().click();
    await catalog;
    await page.waitForLoadState('networkidle');
    // Advanced opens on an MCP warning that can land before or after the form reset.
    // Nothing closes it later, so pinning it open is stable.
    await page.locator('form details').first().evaluate((details) => { details.open = true; });
  });
  await shoot(desktop, origin, '/settings', out('06-settings.png'));
  await shoot(await newPage(browser, origin, [], DESKTOP), origin, '/agents', out('07-empty.png'));
  await shoot(await newPage(browser, origin, sessions, MOBILE), origin, '/agents', out('08-mobile.png'), text('Sync worker retries'));
  console.log(`wrote 8 shots to ${outDir}`);
} finally {
  await browser?.close();
  if (server) {
    server.child.kill();
    if (server.child.exitCode === null) await new Promise((done) => server.child.once('exit', done));
  }
  await rm(scratch, { recursive: true, force: true });
}

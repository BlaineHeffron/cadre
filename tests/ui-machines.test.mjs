// Multi-machine slice 6 UI: the real Agents and Settings pages in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const skip = !process.env.CHROMIUM_BIN;
const since = Date.UTC(2026, 9, 19, 8, 30);
const remoteRow = { id: 'abcd1234', displayName: 'remote child', workDir: '/home/me/repo', tmuxSession: 'claude-abcd1234', state: { status: 'working' }, machine: { id: 'laptop', status: 'unreachable', since } };
const registered = { role: 'hub', canAdd: true, machines: [
  { id: 'laptop', status: 'unreachable', since, label: 'Laptop', url: 'http://laptop.invalid:4320', os: 'darwin', protocol: 2, providers: ['claude'] },
  { id: 'desk', status: 'live', label: 'Desk', url: 'http://desk.invalid:4320', os: 'linux-wsl2', protocol: 2, providers: ['claude'] },
] };
let api = {};
const posted = [];
let app; let browser; let origin;

before(async () => {
  if (skip) return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  app = Fastify();
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/fixture/:page', (req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentsPage } from '/pages/agents.mjs';
    import { SettingsPage } from '/pages/settings.mjs';
    isAuthenticated.value = true;
    render(h(${req.params.page === 'settings' ? 'SettingsPage' : 'AgentsPage'}, {}), document.getElementById('app'));
  </script>`)));
  app.get('/api/agent-bus/model-catalog', () => ({ providers: [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }], models: {} }));
  app.get('/api/agents/providers', () => ({ providers: [{ id: 'codex', enabled: true }, { id: 'claude', enabled: true }] }));
  app.get('/api/claude/sessions', () => ({ sessions: api.sessions }));
  app.get('/api/claude/sessions/:id', () => ({ id: 'abcd1234', content: 'captured on the worker', state: { status: 'working' }, sessionName: 'claude-abcd1234',
    attachCommand: 'tmux attach -t claude-abcd1234', machine: { id: 'laptop', status: 'live', url: 'http://laptop.invalid:4320' } }));
  app.get('/api/machines', () => api.machines);
  app.post('/api/*', (req) => { posted.push({ url: req.url, body: req.body }); return req.url === '/api/pairing/code' ? { link: 'http://worker.invalid:4320/#id.CODE' } : { id: 'new1234', warning: '' }; });
  app.get('/api/*', () => ({ sessions: [] }));
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await app?.close(); });

async function open(page, scenario) {
  api = scenario;
  posted.length = 0;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  tab.setDefaultTimeout(5000);
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(`${origin}/fixture/${page}`);
  return { tab, errors };
}

async function createSession(tab, { provider }) {
  await tab.getByRole('button', { name: 'New', exact: true }).first().click();
  const form = tab.locator('form.new-agent-form');
  await form.getByLabel('Provider').selectOption(provider);
  await form.locator('#agents-workdir-input').fill('/home/me/repo');
  await form.getByRole('button', { name: 'Create Session' }).click();
  return form;
}

describe('multi-machine dashboard', { skip }, () => {
  it('shows the machine chip, the unreachable badge and the remote terminal view with an Open on link', async () => {
    const { tab, errors } = await open('agents', { sessions: [remoteRow], machines: registered });
    const row = tab.locator('.agent-rail-row');
    await row.getByText('laptop', { exact: true }).waitFor();
    await row.getByText('unreachable', { exact: true }).waitFor();
    const detail = tab.getByRole('region', { name: 'Selected agent detail' });
    await detail.getByText('captured on the worker').first().waitFor();
    assert.equal(await detail.getByRole('link', { name: 'Open on laptop' }).getAttribute('href'), 'http://laptop.invalid:4320/claude/abcd1234');
    assert.equal(await detail.getByRole('button', { name: 'Copy Attach' }).count(), 0, 'a local attach command does not reach a remote pane');
    assert.deepEqual(errors, []);
    await tab.close();
  });

  it('offers a machine only while it is live and runs the provider, and sends the choice with the spawn', async () => {
    const { tab } = await open('agents', { sessions: [], machines: registered });
    await tab.getByRole('button', { name: 'New', exact: true }).first().click();
    const select = tab.locator('form.new-agent-form').getByLabel('Run on');
    const options = async () => select.locator('option').evaluateAll((list) => list.map((option) => [option.value, option.textContent.trim(), option.disabled]));
    await select.waitFor();
    const offline = `laptop (offline since ${await tab.evaluate((at) => new Date(at).toLocaleString(), since)})`;
    assert.deepEqual(await options(), [['', 'This machine', false], ['laptop', offline, true], ['desk', 'desk (no codex)', true]]);
    await tab.locator('form.new-agent-form').getByLabel('Provider').selectOption('claude');
    assert.deepEqual(await options(), [['', 'This machine', false], ['laptop', offline, true], ['desk', 'desk', false]]);
    await select.selectOption('desk');
    await tab.locator('#agents-workdir-input').fill('/home/me/repo');
    await tab.getByRole('button', { name: 'Create Session' }).click();
    assert.equal((await waitForPost('/api/agents/sessions')).machine, 'desk');
    await tab.close();
  });

  it('with no machines the spawn form, rows and settings are unchanged', async () => {
    const { tab, errors } = await open('agents', { sessions: [{ ...remoteRow, machine: undefined }], machines: { role: 'hub', canAdd: false, machines: [] } });
    await tab.locator('.agent-rail-row').getByText('remote child').waitFor();
    assert.equal(await tab.locator('.agent-rail-row .badge').count(), 0);
    const form = await createSession(tab, { provider: 'claude' });
    assert.equal(await form.getByLabel('Run on').count(), 0);
    assert.equal('machine' in await waitForPost('/api/agents/sessions'), false);
    await tab.close();
    const settings = await open('settings', { machines: { role: 'hub', canAdd: false, machines: [] } });
    await settings.tab.getByText('Agent Providers').waitFor();
    assert.equal(await settings.tab.getByText('Machines', { exact: true }).count(), 0);
    assert.deepEqual([...errors, ...settings.errors], []);
    await settings.tab.close();
  });

  it('a worker issues a pairing link and a hub redeems one from Settings', async () => {
    const worker = await open('settings', { machines: { role: 'worker', machines: [] } });
    await worker.tab.getByRole('button', { name: 'Pair with hub' }).click();
    assert.equal(await worker.tab.getByLabel('Machine pairing link').inputValue(), 'http://worker.invalid:4320/#id.CODE');
    await worker.tab.close();
    const hub = await open('settings', { machines: registered });
    await hub.tab.getByText('linux-wsl2').waitFor();
    await hub.tab.getByLabel('Machine name').fill('lab');
    await hub.tab.getByLabel('Pairing link').fill(' http://worker.invalid:4320/#id.CODE ');
    await hub.tab.getByRole('button', { name: 'Add machine' }).click();
    assert.deepEqual(await waitForPost('/api/machines'), { name: 'lab', link: 'http://worker.invalid:4320/#id.CODE' });
    await hub.tab.close();
  });
});

async function waitForPost(url) {
  for (let i = 0; i < 100; i += 1) {
    const hit = posted.find((entry) => entry.url === url);
    if (hit) return hit.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no POST ${url}`);
}

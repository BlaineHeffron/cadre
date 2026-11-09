// Local paths in rendered messages link to the Files viewer, and its deep link opens the file.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';
import { renderMarkdownMathNodes } from '../public/components/markdown-math.mjs';
import { filesRoot, LocalPath } from '../public/components/local-path.mjs';

function collect(nodes, type, output = []) {
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) collect(node, type, output);
    else {
      if (node.type === type) output.push(node);
      collect(node.props?.children ?? [], type, output);
    }
  }
  return output;
}

function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}

describe('local path links', () => {
  filesRoot.value = '/home/u/projects';

  it('links a path:line under the root to the Files deep link', () => {
    const nodes = renderMarkdownMathNodes('Changed /home/u/projects/x/y.mjs:12, see it.');
    const links = collect(nodes, 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, '/files?path=%2Fhome%2Fu%2Fprojects%2Fx%2Fy.mjs&line=12');
    assert.equal(text(links[0]), '/home/u/projects/x/y.mjs:12');
    assert.equal(text(nodes), 'Changed /home/u/projects/x/y.mjs:12, see it.');
  });

  it('drops sentence punctuation and links inline code paths', () => {
    const links = collect(renderMarkdownMathNodes('In `/home/u/projects/a` and /home/u/projects/b.md.'), 'a');
    assert.deepEqual(links.map((link) => link.props.href), [
      '/files?path=%2Fhome%2Fu%2Fprojects%2Fa',
      '/files?path=%2Fhome%2Fu%2Fprojects%2Fb.md',
    ]);
  });

  it('leaves paths outside the root, traversal and fenced code blocks plain', () => {
    const source = 'Outside /etc/passwd and /home/u/projectsX/a and /home/u/projects/../secret\n\n```\n/home/u/projects/x/y.mjs:12\n```';
    const nodes = renderMarkdownMathNodes(source);
    assert.equal(collect(nodes, 'a').length, 0);
    assert.match(text(nodes), /\/home\/u\/projects\/x\/y\.mjs:12/);
  });

  it('renders a workDir as a link only under the root', () => {
    assert.equal(LocalPath({ path: '/home/u/projects/app', children: 'app' }).props.href, '/files?path=%2Fhome%2Fu%2Fprojects%2Fapp');
    assert.equal(LocalPath({ path: '/tmp/app' }).type, 'span');
  });
});

test('Files deep link opens the file and highlights the line', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cadre-files-link-')));
  mkdirSync(join(root, 'x'));
  writeFileSync(join(root, 'x', 'y.mjs'), Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));
  process.env.FILE_BROWSER_ROOT = root;
  const app = Fastify();
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    delete process.env.FILE_BROWSER_ROOT;
    rmSync(root, { recursive: true, force: true });
  });
  const { filesPlugin } = await import('../modules/platform/files.mjs');
  await app.register(filesPlugin);
  await app.register(fastifyStatic, { root: `${repo}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${repo}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = readFileSync(`${repo}public/index.html`, 'utf8');
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { FilesPage } from '/pages/files.mjs';
    render(h(FilesPage, { url: location.href }), document.getElementById('app'));
  </script>`)));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${origin}/fixture?path=${encodeURIComponent(join(root, 'x', 'y.mjs'))}&line=60`);
  await page.locator('.card-title', { hasText: 'y.mjs' }).waitFor();
  const mark = page.locator('mark.files-line');
  assert.equal(await mark.textContent(), 'line 60');
  await assert.doesNotReject(() => mark.evaluate((el) => new Promise((resolve, reject) => {
    const box = el.getBoundingClientRect();
    const pane = el.closest('.terminal').getBoundingClientRect();
    (box.top >= pane.top && box.bottom <= pane.bottom ? resolve : reject)();
  })));
  // The directory listing beside it is the file's folder.
  await page.getByText('y.mjs', { exact: true }).last().waitFor();

  await page.goto(`${origin}/fixture?path=x`);
  await page.getByText('y.mjs', { exact: true }).waitFor();
  assert.equal(await page.locator('mark.files-line').count(), 0);
  assert.deepEqual(errors, []);
});

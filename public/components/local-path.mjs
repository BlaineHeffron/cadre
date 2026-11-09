import { h } from 'preact';
import { signal } from '@preact/signals';
import { api } from '../app/api.mjs';

// The Files viewer's allowed root, fetched once. Paths outside it render as plain text.
export const filesRoot = signal('');
let rootRequest = null;

function loadFilesRoot() {
  if (rootRequest || typeof window === 'undefined') return;
  rootRequest = api.get('/files/info')
    .then((info) => { filesRoot.value = info.root || ''; })
    .catch(() => { rootRequest = null; });
}

// Absolute path with an optional :line (and ignored :column) suffix.
const PATH_PATTERN = /(?<![\w/.~:-])(\/[\w.@+-]+(?:\/[\w.@+-]+)*)(?::(\d+))?(?::\d+)?/g;

export function filesHref(path, line) {
  const root = filesRoot.value;
  if (!root || path.includes('..') || (path !== root && !path.startsWith(`${root}/`))) return '';
  return `/files?path=${encodeURIComponent(path)}${line ? `&line=${line}` : ''}`;
}

// Stops the click from also triggering a clickable card the link sits in.
function pathLink(label, href, props) {
  return h('a', { ...props, href, class: 'local-path-link', onClick: (event) => event.stopPropagation() }, label);
}

// Splits text into strings and links to the Files viewer for paths under its root.
export function linkifyPaths(text = '', keyPrefix = 'path') {
  const source = String(text ?? '');
  loadFilesRoot();
  if (!filesRoot.value || !source.includes('/')) return [source];
  const nodes = [];
  let last = 0;
  for (const match of source.matchAll(PATH_PATTERN)) {
    const path = match[1].replace(/[.,]+$/, '');
    const href = filesHref(path, path === match[1] ? match[2] : undefined);
    if (!href) continue;
    const linked = path === match[1] ? match[0] : path;
    if (match.index > last) nodes.push(source.slice(last, match.index));
    nodes.push(pathLink(linked, href, { key: `${keyPrefix}-${match.index}` }));
    last = match.index + linked.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

// A single path, e.g. a session workDir; `children` overrides the shown label.
export function LocalPath({ path = '', children, ...props }) {
  loadFilesRoot();
  const href = filesHref(path);
  const label = children ?? path;
  return href ? pathLink(label, href, { ...props, title: path }) : h('span', { ...props, title: path }, label);
}

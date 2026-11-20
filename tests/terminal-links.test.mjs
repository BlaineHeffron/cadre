// The terminal view's links stop where the URL does, not at the next space.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliStatus } from '../public/components/terminal.mjs';

const hrefs = (line) => {
  const html = CliStatus({ lines: [line] }).props.children[0].props.dangerouslySetInnerHTML.__html;
  return [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, label]) => {
    assert.equal(href.replace(/&amp;/g, '&'), label.replace(/&amp;/g, '&'));
    return label.replace(/&amp;/g, '&');
  });
};

test('linked URLs leave out wrapping markdown and sentence punctuation', () => {
  assert.deepEqual(hrefs('Report: **https://dueno-1.tailc7ab6f.ts.net:8447/iu-tech-report-html/index.html**'),
    ['https://dueno-1.tailc7ab6f.ts.net:8447/iu-tech-report-html/index.html']);
  assert.deepEqual(hrefs('*https://a.example/one* __https://a.example/two__ `https://a.example/three`'),
    ['https://a.example/one', 'https://a.example/two', 'https://a.example/three']);
  assert.deepEqual(hrefs('[docs](https://a.example/docs) [https://a.example/x](https://a.example/x)'),
    ['https://a.example/docs', 'https://a.example/x', 'https://a.example/x']);
  assert.deepEqual(hrefs('See https://a.example/end. Or https://a.example/b, (https://a.example/c) "https://a.example/q"'),
    ['https://a.example/end', 'https://a.example/b', 'https://a.example/c', 'https://a.example/q']);
});

test('linked URLs keep balanced parentheses, query strings and fragments', () => {
  assert.deepEqual(hrefs('https://en.wikipedia.org/wiki/Foo_(bar) and (https://en.wikipedia.org/wiki/Foo_(bar)).'),
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(hrefs('**https://a.example/s?q=a&b=2#frag**'), ['https://a.example/s?q=a&b=2#frag']);
});

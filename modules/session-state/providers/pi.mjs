import { detectPaneObservations } from './detector.mjs';
import { PI_CONTEXT_FOOTER_RE } from './patterns.mjs';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;


function normalizedLines(content) {
  return String(content || '')
    .replace(ANSI_ESCAPE_RE, '')
    .split('\n')
    .map((line) => line.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function parsePiRuntimeFooter(content) {
  for (const line of normalizedLines(content).slice(-8).reverse()) {
    const footer = line.match(PI_CONTEXT_FOOTER_RE);
    if (!footer) continue;
    const runtime = footer[1].replace(/^\([^)]+\)\s+/, '').trim();
    const segments = runtime.split(/\s+•\s+/);
    const effectiveModel = String(segments[0] || '').trim();
    if (!/^[a-z0-9][a-z0-9_.:/-]*$/i.test(effectiveModel)) continue;
    const thinkingText = String(segments[1] || '').trim().toLowerCase();
    const effectiveThinkingLevel = thinkingText === 'thinking off' ? 'off' : thinkingText;
    return {
      effectiveModel,
      effectiveThinkingLevel: THINKING_LEVELS.has(effectiveThinkingLevel)
        ? effectiveThinkingLevel
        : '',
    };
  }
  return null;
}

export function observePiPane(content, options = {}) {
  return detectPaneObservations({
    provider: 'pi',
    content,
    ...options,
    runtime: parsePiRuntimeFooter(content),
  });
}

export const detectPiPaneObservations = observePiPane;

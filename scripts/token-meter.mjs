#!/usr/bin/env node
// Token meter for Cadre-run agent sessions.
//   node scripts/token-meter.mjs                    static seams from this checkout
//   node scripts/token-meter.mjs --transcripts [N]  also the last N Claude transcripts that loaded dueno
//   --json prints raw numbers instead of tables.
// Tokens are estimated as chars / CHARS_PER_TOKEN. The ratio is calibrated against Claude's own
// `usage` on 297 real first requests (median 2.97 JSON chars per token, range 2.91–3.02).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHARS_PER_TOKEN = 2.97;
export const tokens = (value) => Math.round(
  (typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / CHARS_PER_TOKEN,
);

const DELIVERY_RE = /^\s*(?:<pasted_content[^>]*>\s*)?\[(?:ROOM_MESSAGE|DM) /;
const DUENO = 'mcp__dueno__';

function userText(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}

// One transcript: what the first request carried, and what every later call re-read.
export function meterTranscript(lines) {
  const out = {
    dueno: false, firstRequestTokens: 0, calls: 0, inputTokens: 0, outputTokens: 0,
    first: { system: 0, builtinTools: 0, duenoToolNames: 0, otherDeferredNames: 0, skillListing: 0, instructions: 0, initialPrompt: 0 },
    traffic: {},
  };
  const toolNames = new Map();
  const seenMessages = new Set();
  const events = []; // [callIndex, seam, chars]
  let firstPromptSeen = false;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const attachment = record.attachment;
    if (record.type === 'api-request-shape' && !out.first.system) {
      out.first.system = tokens(record.shape?.system);
      out.first.builtinTools = tokens(record.shape?.tools);
    } else if (attachment?.type === 'deferred_tools_delta' && out.calls === 0) {
      const names = attachment.addedNames || [];
      const dueno = names.filter((name) => name.startsWith(DUENO));
      if (dueno.length) out.dueno = true;
      out.first.duenoToolNames += tokens(dueno.join('\n'));
      out.first.otherDeferredNames += tokens(names.filter((name) => !name.startsWith(DUENO)).join('\n'));
    } else if (attachment?.type === 'skill_listing' && out.calls === 0) {
      out.first.skillListing += tokens(attachment.content);
    } else if (attachment?.type === 'instructions' && out.calls === 0) {
      out.first.instructions += tokens((attachment.files || []).map((file) => file.content).join('\n'));
    } else if (record.type === 'assistant') {
      const message = record.message || {};
      for (const block of message.content || []) {
        if (block?.type === 'tool_use') toolNames.set(block.id, block.name);
      }
      const usage = message.usage;
      if (!usage || seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      if (!out.calls) out.firstRequestTokens = input;
      out.calls += 1;
      out.inputTokens += input;
      out.outputTokens += usage.output_tokens || 0;
    } else if (record.type === 'user' && !record.isMeta) {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const name = toolNames.get(block.tool_use_id) || '';
          const body = JSON.stringify(block.content ?? '');
          const seam = name.startsWith(DUENO) ? name.slice(DUENO.length)
            : name === 'ToolSearch' && body.includes(DUENO) ? 'ToolSearch(dueno schemas)' : '';
          if (seam) events.push([out.calls, seam, body.length]);
        }
      }
      const text = userText(content);
      if (!text) continue;
      if (!firstPromptSeen) {
        firstPromptSeen = true;
        out.first.initialPrompt = tokens(text);
      } else if (DELIVERY_RE.test(text)) {
        events.push([out.calls, 'inbound room/DM delivery', text.length]);
      }
    }
  }
  // A result added before call i is re-read by every call from i on (until compaction; ignored).
  for (const [callIndex, seam, chars] of events) {
    const row = out.traffic[seam] ||= { count: 0, tokens: 0, carried: 0 };
    const size = Math.round(chars / CHARS_PER_TOKEN);
    row.count += 1;
    row.tokens += size;
    row.carried += size * Math.max(0, out.calls - callIndex);
  }
  return out;
}

export function meterTranscripts(files) {
  const total = { sessions: 0, calls: 0, inputTokens: 0, outputTokens: 0, firstRequestTokens: 0, first: {}, firstCarried: {}, traffic: {} };
  for (const file of files) {
    const session = meterTranscript(readFileSync(file, 'utf8').split('\n'));
    if (!session.dueno || !session.calls) continue;
    total.sessions += 1;
    for (const key of ['calls', 'inputTokens', 'outputTokens', 'firstRequestTokens']) total[key] += session[key];
    for (const [key, value] of Object.entries(session.first)) {
      total.first[key] = (total.first[key] || 0) + value;
      total.firstCarried[key] = (total.firstCarried[key] || 0) + value * session.calls; // prefix is re-read every call
    }
    for (const [seam, row] of Object.entries(session.traffic)) {
      const sum = total.traffic[seam] ||= { count: 0, tokens: 0, carried: 0 };
      for (const key of Object.keys(sum)) sum[key] += row[key];
    }
  }
  return total;
}

export async function meterStatic() {
  const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
  const { buildInProcessAgentBusMcpServer } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { AGENT_BUS_AGENT_TOOL_SCOPES } = await import('../modules/agent-bus/mcp-auth.mjs');
  const { FLEET_SUPERVISOR_MCP_TOOL_SCOPES } = await import('../modules/integrations/mcp-launch-preflight.mjs');
  const { renderCollabStartupPrompt } = await import('../modules/agent-bus/protocol.mjs');
  const { BUILTIN_PROFILES } = await import('../modules/integrations/prompt-profile-catalog.mjs');
  const { discoverLaunchSkills } = await import('../modules/integrations/launch-skills.mjs');

  const requestImpl = async () => ({});
  const server = buildInProcessAgentBusMcpServer({
    requestImpl,
    monitorMcp: buildMonitorMcpServer({ requestImpl }),
    credentialStore: { recordRejectedCall: async () => {} },
  });
  const listTools = async (toolScopes) => (await server.handleRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { authContext: { authenticated: true, toolScopes } },
  )).result.tools;
  // Default agent credential is ['*', ...agent scopes] (mcp-launch-preflight credentialProfileDefaults).
  const profiles = {
    'agent (default)': await listTools(['*', ...AGENT_BUS_AGENT_TOOL_SCOPES]),
    'fleet-supervisor': await listTools([...FLEET_SUPERVISOR_MCP_TOOL_SCOPES]),
    'agent-bus scopes only': await listTools([...AGENT_BUS_AGENT_TOOL_SCOPES]),
  };
  const mcp = Object.fromEntries(Object.entries(profiles).map(([id, tools]) => [id, {
    tools: tools.length,
    nameTokens: tokens(tools.map((tool) => `${DUENO}${tool.name}`).join('\n')),
    schemaTokens: tokens(tools),
  }]));
  const largestTools = profiles['agent (default)']
    .map((tool) => ({ name: tool.name, tokens: tokens(tool) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, 10);

  const self = { kind: 'claude', sessionId: 'aaaaaaaa', displayName: 'implementer', role: 'implementer' };
  const peer = { kind: 'codex', sessionId: 'bbbbbbbb', displayName: 'reviewer' };
  const collabWrapper = renderCollabStartupPrompt({
    self, participants: [self, peer], threadId: `thr_${'0'.repeat(32)}`, title: 'Example', initialTask: '',
  });
  const guidance = await server.handleRequest(
    { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'collaboration_guidance' } },
    { authContext: { authenticated: true, toolScopes: ['*'] } },
  );
  // Checked-in profiles and skills only, so the numbers do not depend on local config.
  const promptProfiles = Object.values(BUILTIN_PROFILES)
    .map((profile) => ({ id: profile.id, tokens: tokens(`${profile.template || ''}${profile.startupTask || ''}`) }));
  const repoSkills = fileURLToPath(new URL('../config/skills', import.meta.url));
  const skills = discoverLaunchSkills({ sourceConfig: { launchSkills: { dir: repoSkills, localDir: join(repoSkills, '.none') } } }).map((skill) => tokens(skill.body || '')).sort((a, b) => a - b);
  return {
    mcp,
    largestTools,
    collabWrapperTokens: tokens(collabWrapper),
    collaborationGuidanceTokens: tokens(guidance.result?.messages ?? ''),
    promptProfiles,
    launchSkills: {
      count: skills.length,
      medianTokens: skills[Math.floor(skills.length / 2)] || 0,
      maxTokens: skills.at(-1) || 0,
      totalTokens: skills.reduce((sum, value) => sum + value, 0),
    },
  };
}

function recentTranscripts(dir, limit) {
  const files = [];
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of readdirSync(join(dir, project.name))) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, project.name, name);
      files.push([statSync(path).mtimeMs, path]);
    }
  }
  return files.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, path]) => path);
}

const fmt = (value) => Math.round(value).toLocaleString('en-US');
function table(title, header, rows) {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => String(row[index]).length)));
  const line = (row) => `| ${row.map((cell, index) => String(cell)[index ? 'padStart' : 'padEnd'](widths[index])).join(' | ')} |`;
  return [`\n### ${title}`, line(header), `|${widths.map((width, index) => `${index ? '' : ':'}${'-'.repeat(width + 1)}${index ? ':' : ''}`).join('|')}|`, ...rows.map(line)].join('\n');
}

function render(staticResult, live) {
  const out = [`Token meter — estimate: chars / ${CHARS_PER_TOKEN} (calibrated on Claude usage)`];
  out.push(table('Static: dueno MCP tools/list per credential profile', ['profile', 'tools', 'names only', 'full schemas'],
    Object.entries(staticResult.mcp).map(([id, row]) => [id, row.tools, fmt(row.nameTokens), fmt(row.schemaTokens)])));
  out.push(table('Static: largest dueno tool schemas', ['tool', 'tokens'], staticResult.largestTools.map((row) => [row.name, fmt(row.tokens)])));
  out.push(table('Static: injected startup text', ['seam', 'tokens'], [
    ['collab startup wrapper (no task)', fmt(staticResult.collabWrapperTokens)],
    ['collaboration_guidance prompt', fmt(staticResult.collaborationGuidanceTokens)],
    ...staticResult.promptProfiles.map((row) => [`prompt profile: ${row.id}`, fmt(row.tokens)]),
    [`launch skills (${staticResult.launchSkills.count}): median per skill`, fmt(staticResult.launchSkills.medianTokens)],
    ['launch skills: largest skill', fmt(staticResult.launchSkills.maxTokens)],
  ]));
  if (!live) return out.join('\n');
  const n = Math.max(live.sessions, 1);
  out.push(`\nLive: ${live.sessions} Claude sessions with dueno, ${fmt(live.calls)} API calls, ${fmt(live.inputTokens)} input tokens processed (incl. cache reads), ${fmt(live.outputTokens)} output.`);
  const pct = (value, of) => `${((100 * value) / Math.max(of, 1)).toFixed(2)}%`;
  out.push(table('Live: startup prefix, mean per session (carried = tokens × calls)', ['seam', 'tokens', 'share', '% of input'], [
    ['first request total (usage)', fmt(live.firstRequestTokens / n), '100%', ''],
    ...Object.entries(live.first).map(([seam, value]) => [seam, fmt(value / n), pct(value, live.firstRequestTokens), pct(live.firstCarried[seam], live.inputTokens)]),
  ]));
  const rows = Object.entries(live.traffic).sort((a, b) => b[1].carried - a[1].carried);
  out.push(table('Live: coordination traffic (carried = tokens × later calls that re-read them)', ['seam', 'count', 'tokens', 'carried', '% of input'],
    rows.map(([seam, row]) => [seam, row.count, fmt(row.tokens), fmt(row.carried), pct(row.carried, live.inputTokens)])));
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--transcripts');
  const staticResult = await meterStatic();
  const live = at === -1 ? null : meterTranscripts(recentTranscripts(
    process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects'),
    Number(args[at + 1]) || 200,
  ));
  console.log(args.includes('--json') ? JSON.stringify({ static: staticResult, live }, null, 2) : render(staticResult, live));
}

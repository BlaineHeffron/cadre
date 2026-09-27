import { exec } from '../../lib/exec.mjs';
import { spawn } from 'node:child_process';
import { sendTmuxText } from './tmux-input.mjs';
import { isRustManagedTmuxTarget } from '../agent/tmux-classifier.mjs';
import { shellQuote } from './shell-quote.mjs';

// ── Input validation ──

function validateTmuxIdentifier(id) {
  // Tmux session/window names and pane IDs: alphanumeric, underscores, hyphens, dots, colons, percent signs
  // Reject shell metacharacters and path traversal
  if (!/^[a-zA-Z0-9_.:%-]+$/.test(id)) {
    throw new Error('Invalid tmux identifier format');
  }
  if (id.includes('..')) {
    throw new Error('Path traversal detected in identifier');
  }
  return id;
}

function rejectRustManagedTmuxMutation(target, reply) {
  if (!isRustManagedTmuxTarget(target)) return false;
  reply.code(403).send({ error: 'Tmux target is rust-managed and read-only' });
  return true;
}

/**
 * Parse tmux list-sessions output into structured data.
 * Format: "session_name: N windows (created ...)"
 */
function parseSessions(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^(.+?):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)/);
    if (!match) return { name: line.trim(), windows: 0, created: '' };
    return { name: match[1], windows: Number(match[2]), created: match[3] };
  });
}

/**
 * Parse tmux list-windows output.
 * Format: "0: name* (N panes) [WxH] [layout ...]"
 */
function parseWindows(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^(\d+):\s+(.+?)\s+\((\d+)\s+panes?\)/);
    if (!match) return { index: 0, name: line.trim(), panes: 0 };
    return { index: Number(match[1]), name: match[2], panes: Number(match[3]) };
  });
}

/**
 * Parse tmux list-panes output.
 * Format: "%id: [WxH] [history ...] %pid ..."
 */
function parsePanes(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map((line, i) => {
    const match = line.match(/^(%\d+):\s+\[(\d+)x(\d+)\]/);
    if (!match) return { id: `%${i}`, index: i, width: 80, height: 24 };
    return { id: match[1], index: i, width: Number(match[2]), height: Number(match[3]) };
  });
}

function spawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...opts,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function commandExists(cmd) {
  try {
    const { code } = await exec('which', [cmd]);
    return code === 0;
  } catch {
    return false;
  }
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return shellQuote(text);
}

// lib/exec.mjs strips this process's $TMUX before running tmux, so discovery,
// capture, and key delivery all talk to whatever server tmux resolves without
// it. Attach commands must name that server, not the inherited socket, which
// can exist (e.g. a keepalive on dm-agent) without owning any Fleet session.
export async function resolveTmuxSocketPath() {
  const { stdout, code } = await exec('tmux', ['display-message', '-p', '#{socket_path}']);
  return code === 0 ? stdout.trim() : '';
}

export function buildAttachCommand(session, { socketPath = '' } = {}) {
  const socketFlag = socketPath ? ` -S ${shellArg(socketPath)}` : '';
  return `tmux${socketFlag} attach -t ${shellQuote(session)}`;
}

function assertGuiSessionAvailable() {
  if (process.platform === 'win32') return;
  if (process.platform === 'darwin') return;

  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const hasRuntimeDir = Boolean(process.env.XDG_RUNTIME_DIR);
  if (!hasDisplay || !hasRuntimeDir) {
    throw new Error('No desktop session available to launch a terminal app from the server process');
  }
}

async function openInLinuxTerminal(session, socketPath) {
  assertGuiSessionAvailable();
  const attachCmd = buildAttachCommand(session, { socketPath });
  const launchers = [
    { bin: 'terminator', args: ['-x', 'bash', '-lc', attachCmd] },
    { bin: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', attachCmd] },
    { bin: 'gnome-terminal', args: ['--', 'bash', '-lc', attachCmd] },
    { bin: 'konsole', args: ['-e', 'bash', '-lc', attachCmd] },
    { bin: 'alacritty', args: ['-e', 'bash', '-lc', attachCmd] },
    { bin: 'kitty', args: ['bash', '-lc', attachCmd] },
    { bin: 'wezterm', args: ['start', '--', 'bash', '-lc', attachCmd] },
  ];

  for (const launcher of launchers) {
    if (!await commandExists(launcher.bin)) continue;
    await spawnDetached(launcher.bin, launcher.args);
    return launcher.bin;
  }

  throw new Error('No supported terminal app found to open tmux');
}

async function openInWindowsTerminal(session, socketPath) {
  const attachCmd = buildAttachCommand(session, { socketPath });
  const launchers = [
    { bin: 'wt.exe', args: ['wsl.exe', '-e', 'bash', '-lc', attachCmd] },
    { bin: 'cmd.exe', args: ['/c', 'start', '', 'wsl.exe', '-e', 'bash', '-lc', attachCmd] },
  ];

  for (const launcher of launchers) {
    try {
      await spawnDetached(launcher.bin, launcher.args);
      return launcher.bin;
    } catch {
      // Try the next launcher
    }
  }

  throw new Error('Failed to launch terminal on Windows (wt.exe/cmd.exe)');
}

async function openInMacTerminal(session, socketPath) {
  const command = buildAttachCommand(session, { socketPath })
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"');

  const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "${command}"`;
  const { code, stderr } = await exec('osascript', ['-e', script]);
  if (code !== 0) throw new Error(stderr || 'Failed to open Terminal.app');
  return 'Terminal.app';
}

async function openTmuxInTerminal(session, socketPath) {
  if (process.platform === 'win32') return openInWindowsTerminal(session, socketPath);
  if (process.platform === 'darwin') return openInMacTerminal(session, socketPath);
  return openInLinuxTerminal(session, socketPath);
}

async function getTerminalLaunchCapability() {
  const command = process.platform === 'win32'
    ? 'wt.exe'
    : process.platform === 'darwin'
      ? 'Terminal.app'
      : 'terminator';

  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    try {
      assertGuiSessionAvailable();
    } catch (err) {
      return {
        canOpenTerminal: false,
        preferredTerminal: command,
        reason: err.message,
      };
    }

    if (!await commandExists('terminator')) {
      return {
        canOpenTerminal: false,
        preferredTerminal: command,
        reason: 'Terminator is not installed on the host machine',
      };
    }
  }

  return {
    canOpenTerminal: true,
    preferredTerminal: command,
    reason: '',
  };
}

// ── REST Endpoints ──

export async function tmuxPlugin(app, { wsManager }) {
  app.get('/api/tmux/capabilities', async () => getTerminalLaunchCapability());

  // Flat list of all panes across all sessions (single tmux call)
  app.get('/api/tmux/tree', async (_req, reply) => {
    const { stdout, code } = await exec('tmux', [
      'list-panes', '-a', '-F',
      '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}',
    ]);
    if (code !== 0) return reply.send({ panes: [] });

    const socketPath = await resolveTmuxSocketPath();
    const panes = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [session, winIndex, winName, paneIndex, paneId, width, height, cmd] = line.split('\t');
      return {
        session,
        attachCommand: buildAttachCommand(session, { socketPath }),
        windowIndex: Number(winIndex),
        windowName: winName,
        paneIndex: Number(paneIndex),
        paneId,
        width: Number(width),
        height: Number(height),
        command: cmd || '',
        target: `${session}:${winIndex}.${paneIndex}`,
      };
    });

    return { panes };
  });

  // List all tmux sessions
  app.get('/api/tmux/sessions', async (_req, reply) => {
    const { stdout, code } = await exec('tmux', ['list-sessions']);
    if (code !== 0) return reply.send({ sessions: [] });
    const socketPath = await resolveTmuxSocketPath();
    return {
      sessions: parseSessions(stdout).map((session) => ({
        ...session,
        attachCommand: buildAttachCommand(session.name, { socketPath }),
      })),
    };
  });

  // List windows in a session
  app.get('/api/tmux/sessions/:session/windows', async (req, reply) => {
    try {
      const session = validateTmuxIdentifier(req.params.session);
      const { stdout, code } = await exec('tmux', ['list-windows', '-t', session]);
      if (code !== 0) return reply.code(404).send({ error: `Session not found: ${session}` });
      return { windows: parseWindows(stdout) };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // List panes in a window
  app.get('/api/tmux/sessions/:session/windows/:window/panes', async (req, reply) => {
    try {
      const session = validateTmuxIdentifier(req.params.session);
      const win = validateTmuxIdentifier(req.params.window);
      const target = `${session}:${win}`;
      const { stdout, code } = await exec('tmux', ['list-panes', '-t', target, '-F', '#{pane_id}: [#{pane_width}x#{pane_height}]']);
      if (code !== 0) return reply.code(404).send({ error: `Window not found: ${target}` });
      return { panes: parsePanes(stdout) };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Capture pane content (snapshot)
  app.get('/api/tmux/pane/:target', async (req, reply) => {
    try {
      const target = validateTmuxIdentifier(req.params.target);
      const { stdout, code } = await exec('tmux', ['capture-pane', '-t', target, '-p', '-e']);
      if (code !== 0) return reply.code(404).send({ error: `Pane not found: ${target}` });
      return { content: stdout };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Create a new tmux session
  app.post('/api/tmux/sessions', async (req, reply) => {
    try {
      const { name } = req.body || {};
      if (!name || !name.trim()) return reply.code(400).send({ error: 'Missing session name' });
      const sessionName = name.trim();
      if (!/^[a-zA-Z0-9_.-]+$/.test(sessionName)) {
        return reply.code(400).send({ error: 'Invalid session name (alphanumeric, _, -, . only)' });
      }
      const { code, stderr } = await exec('tmux', ['new-session', '-d', '-s', sessionName]);
      if (code !== 0) return reply.code(400).send({ error: stderr || 'Failed to create session' });
      return { ok: true, name: sessionName };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Open a session in local terminal app (WSL on Windows)
  app.post('/api/tmux/sessions/:session/open', async (req, reply) => {
    try {
      const session = validateTmuxIdentifier(req.params.session);
      if (rejectRustManagedTmuxMutation(session, reply)) return reply;
      const check = await exec('tmux', ['has-session', '-t', session]);
      if (check.code !== 0) return reply.code(404).send({ error: `Session not found: ${session}` });
      const socketPath = await resolveTmuxSocketPath();
      const command = buildAttachCommand(session, { socketPath });

      const launcher = await openTmuxInTerminal(session, socketPath);
      return {
        ok: true,
        session,
        launcher,
        command,
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message || 'Failed to open terminal' });
    }
  });

  // Send keys to a pane
  app.post('/api/tmux/pane/:target/keys', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const target = validateTmuxIdentifier(req.params.target);
      if (rejectRustManagedTmuxMutation(target, reply)) return reply;
      const { keys } = req.body || {};
      if (!keys) return reply.code(400).send({ error: 'Missing keys in request body' });

      const { code, stderr } = await exec('tmux', ['send-keys', '-t', target, '--', ...keys.split(' ')]);
      if (code !== 0) return reply.code(400).send({ error: stderr || 'Failed to send keys' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Send literal text to a pane (then optionally Enter)
  app.post('/api/tmux/pane/:target/input', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const target = validateTmuxIdentifier(req.params.target);
      if (rejectRustManagedTmuxMutation(target, reply)) return reply;
      const { text, enter } = req.body || {};
      return await sendTmuxText(exec, { target, text, enter, delayMs: 300, bufferPrefix: 'dueno-pane' });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Kill (close) a pane
  app.delete('/api/tmux/pane/:target', async (req, reply) => {
    try {
      const target = validateTmuxIdentifier(req.params.target);
      if (rejectRustManagedTmuxMutation(target, reply)) return reply;
      const { code, stderr } = await exec('tmux', ['kill-pane', '-t', target]);
      if (code !== 0) return reply.code(400).send({ error: stderr || 'Failed to kill pane' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── WebSocket Streaming ──

  // Track active streaming intervals per channel
  const streamIntervals = new Map();
  const lastStreamContent = new Map();

  wsManager.onChannel('tmux', (socket, channel, data) => {
    // Channel format: tmux:pane:<target>
    const parts = channel.split(':');
    if (parts.length < 3 || parts[1] !== 'pane') return;

    const target = parts.slice(2).join(':');

    // Validate target before starting stream
    try {
      validateTmuxIdentifier(target);
    } catch (err) {
      wsManager.broadcast(channel, 'error', { error: err.message });
      return;
    }

    if (['keys', 'input', 'send-keys', 'text'].includes(data?.action)) {
      const error = isRustManagedTmuxTarget(target)
        ? 'Tmux target is rust-managed and read-only'
        : 'Tmux websocket input is not supported';
      wsManager.broadcast(channel, 'error', { error, code: isRustManagedTmuxTarget(target) ? 'read_only' : 'unsupported_action' });
      return;
    }

    const intervalKey = channel;

    // Start streaming if not already running for this channel
    if (!streamIntervals.has(intervalKey)) {
      const interval = setInterval(async () => {
        const clients = wsManager.channels.get(channel);
        if (!clients || clients.size === 0) {
          clearInterval(interval);
          streamIntervals.delete(intervalKey);
          lastStreamContent.delete(intervalKey);
          return;
        }

        try {
          const { stdout, code, stderr } = await exec('tmux', ['capture-pane', '-t', target, '-p', '-e']);
          if (code === 0) {
            if (lastStreamContent.get(intervalKey) !== stdout) {
              lastStreamContent.set(intervalKey, stdout);
              wsManager.broadcast(channel, 'content', { content: stdout });
            }
          } else {
            wsManager.broadcast(channel, 'error', { error: stderr || 'Failed to capture pane' });
            clearInterval(interval);
            streamIntervals.delete(intervalKey);
            lastStreamContent.delete(intervalKey);
          }
        } catch (err) {
          wsManager.broadcast(channel, 'error', { error: err.message || 'Exception during pane capture' });
          clearInterval(interval);
          streamIntervals.delete(intervalKey);
          lastStreamContent.delete(intervalKey);
        }
      }, 3000);

      streamIntervals.set(intervalKey, interval);
    }
  });

  // Cleanup on server close
  app.addHook('onClose', async () => {
    for (const interval of streamIntervals.values()) {
      clearInterval(interval);
    }
    streamIntervals.clear();
    lastStreamContent.clear();
  });
}

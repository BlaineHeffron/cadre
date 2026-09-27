import { exec } from '../../lib/exec.mjs';
import { FileTailer } from '../../lib/tail.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// ── Alert storage ──

const alerts = [];
const MAX_ALERTS = 1000;

function addAlert(severity, category, message, details = {}) {
  const alert = {
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    severity, // 'low', 'medium', 'high', 'critical'
    category, // 'auth', 'network', 'process', 'integrity'
    message,
    details,
    acknowledged: false,
  };

  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;

  return alert;
}

// ── Auth.log watcher ──

function startAuthWatcher(wsManager) {
  const authLogPath = '/var/log/auth.log';
  const authTailer = new FileTailer(authLogPath);
  let disposed = false;

  authTailer.on('line', (line) => {
    // Failed password attempts
    if (line.includes('Failed password')) {
      const ipMatch = line.match(/from\s+([\d.]+)/);
      const userMatch = line.match(/for\s+(?:invalid user\s+)?(\S+)/);
      const alert = addAlert('high', 'auth', 'Failed SSH login attempt', {
        ip: ipMatch?.[1] || 'unknown',
        user: userMatch?.[1] || 'unknown',
        raw: line,
      });
      wsManager.broadcast('threats', 'alert', alert);
    }

    // Successful logins from unexpected sources
    if (line.includes('Accepted')) {
      const ipMatch = line.match(/from\s+([\d.]+)/);
      const userMatch = line.match(/for\s+(\S+)/);
      const alert = addAlert('medium', 'auth', 'SSH login accepted', {
        ip: ipMatch?.[1] || 'unknown',
        user: userMatch?.[1] || 'unknown',
        raw: line,
      });
      wsManager.broadcast('threats', 'alert', alert);
    }

    // sudo attempts
    if (line.includes('sudo') && line.includes('COMMAND=')) {
      const userMatch = line.match(/^\S+\s+\S+\s+\S+\s+(\S+)/);
      const cmdMatch = line.match(/COMMAND=(.+)$/);
      const alert = addAlert('low', 'auth', 'Sudo command executed', {
        user: userMatch?.[1] || 'unknown',
        command: cmdMatch?.[1] || 'unknown',
        raw: line,
      });
      wsManager.broadcast('threats', 'alert', alert);
    }
  });

  authTailer.on('error', (err) => {
    // auth.log might not be readable — log and continue
    console.warn('Auth log watcher error:', err.message);
  });

  authTailer.start()
    .then(() => {
      if (disposed) authTailer.stop();
    })
    .catch((err) => {
      console.error('Failed to start auth log watcher:', err.message);
    });

  return () => {
    disposed = true;
    authTailer.stop();
  };
}

// ── Connection monitor (ss) ──

function parseSsOutput(stdout) {
  const connections = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5) {
      connections.push({
        proto: parts[0],
        state: parts[1],
        local: parts[3],
        remote: parts[4],
      });
    }
  }
  return connections;
}

function startConnectionMonitor(wsManager, intervalMs = 30000) {
  const knownConnections = new Set();
  let connectionInProgress = false;
  const connectionInterval = setInterval(async () => {
    if (connectionInProgress) return;
    connectionInProgress = true;

    try {
      const { stdout, code } = await exec('ss', ['-tunaH']);
      if (code !== 0) return;

      const connections = parseSsOutput(stdout);

      // Detect new ESTABLISHED connections
      for (const conn of connections) {
        if (conn.state !== 'ESTAB') continue;
        const key = `${conn.proto}:${conn.remote}`;
        if (!knownConnections.has(key)) {
          knownConnections.add(key);
          const alert = addAlert('low', 'network', `New connection: ${conn.remote}`, conn);
          wsManager.broadcast('threats', 'alert', alert);
        }
      }

      wsManager.broadcast('threats', 'connections', { connections });
    } finally {
      connectionInProgress = false;
    }
  }, intervalMs);

  return () => clearInterval(connectionInterval);
}

// ── Process monitor (ps) ──

function startProcessMonitor(wsManager, intervalMs = 60000) {
  const knownProcesses = new Set();
  const expiryTimeouts = new Set();
  let processInProgress = false;
  const processInterval = setInterval(async () => {
    if (processInProgress) return;
    processInProgress = true;

    try {
      const { stdout, code } = await exec('ps', ['aux', '--sort=-pcpu']);
      if (code !== 0) return;

      const processes = [];
      const lines = stdout.trim().split('\n');
      // Skip header
      for (let i = 1; i < lines.length && i < 50; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 11) {
          processes.push({
            user: parts[0],
            pid: parts[1],
            cpu: parts[2],
            mem: parts[3],
            command: parts.slice(10).join(' '),
          });
        }
      }

      // Detect high CPU processes
      for (const proc of processes) {
        const cpu = parseFloat(proc.cpu);
        if (cpu > 90) {
          const key = `highcpu:${proc.pid}`;
          if (!knownProcesses.has(key)) {
            knownProcesses.add(key);
            const alert = addAlert('medium', 'process', `High CPU: ${proc.command} (${cpu}%)`, proc);
            wsManager.broadcast('threats', 'alert', alert);

            // Clear after 5 minutes so it can re-trigger
            const timeout = setTimeout(() => {
              knownProcesses.delete(key);
              expiryTimeouts.delete(timeout);
            }, 300000);
            expiryTimeouts.add(timeout);
          }
        }
      }

      wsManager.broadcast('threats', 'processes', { processes: processes.slice(0, 20) });
    } finally {
      processInProgress = false;
    }
  }, intervalMs);

  return () => {
    clearInterval(processInterval);
    for (const timeout of expiryTimeouts) clearTimeout(timeout);
    expiryTimeouts.clear();
  };
}

// ── File integrity monitor ──

const WATCHED_PATHS = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/ssh/sshd_config',
  '/etc/crontab',
  '/etc/sudoers',
];

async function hashFile(filePath) {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function startIntegrityMonitor(wsManager, intervalMs = 300000) {
  const fileHashes = new Map();
  let integrityInProgress = false;

  // Initial baseline
  (async () => {
    for (const p of WATCHED_PATHS) {
      const hash = await hashFile(p);
      if (hash) fileHashes.set(p, hash);
    }
  })();

  const integrityInterval = setInterval(async () => {
    if (integrityInProgress) return;
    integrityInProgress = true;

    try {
      for (const p of WATCHED_PATHS) {
        const hash = await hashFile(p);
        if (!hash) continue;

        const prev = fileHashes.get(p);
        if (prev && prev !== hash) {
          const alert = addAlert('critical', 'integrity', `File modified: ${p}`, {
            path: p,
            previousHash: prev,
            currentHash: hash,
          });
          wsManager.broadcast('threats', 'alert', alert);
        }
        fileHashes.set(p, hash);
      }
    } finally {
      integrityInProgress = false;
    }
  }, intervalMs);

  return () => clearInterval(integrityInterval);
}

// ── Fastify Plugin ──

const defaultMonitorStarters = {
  startAuthWatcher,
  startConnectionMonitor,
  startProcessMonitor,
  startIntegrityMonitor,
};

export async function threatPlugin(app, {
  wsManager,
  sideEffectLoopsSuppressed = true,
  monitorStarters = defaultMonitorStarters,
}) {
  const disposers = [];

  app.addHook('onClose', async () => {
    const cleanupErrors = [];
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Failed to stop threat monitors');
  });

  if (!sideEffectLoopsSuppressed) {
    for (const startMonitor of [
      monitorStarters.startAuthWatcher,
      monitorStarters.startConnectionMonitor,
      monitorStarters.startProcessMonitor,
      monitorStarters.startIntegrityMonitor,
    ]) {
      const dispose = startMonitor(wsManager);
      if (typeof dispose === 'function') disposers.push(dispose);
    }
  }

  // REST: Get all alerts
  app.get('/api/threats/alerts', async (req) => {
    const limit = Number(req.query.limit) || 50;
    const severity = req.query.severity;
    const category = req.query.category;

    let filtered = alerts;
    if (severity) filtered = filtered.filter(a => a.severity === severity);
    if (category) filtered = filtered.filter(a => a.category === category);

    return { alerts: filtered.slice(0, limit), total: filtered.length };
  });

  // REST: Acknowledge an alert
  app.post('/api/threats/alerts/:id/ack', async (req, reply) => {
    const alert = alerts.find(a => a.id === req.params.id);
    if (!alert) return reply.code(404).send({ error: 'Alert not found' });
    alert.acknowledged = true;
    return { ok: true };
  });

  // REST: Get current connections
  app.get('/api/threats/connections', async () => {
    const { stdout, code } = await exec('ss', ['-tunaH']);
    if (code !== 0) return { connections: [] };
    return { connections: parseSsOutput(stdout) };
  });

  // REST: Get system overview
  app.get('/api/threats/overview', async () => {
    const critical = alerts.filter(a => a.severity === 'critical' && !a.acknowledged).length;
    const high = alerts.filter(a => a.severity === 'high' && !a.acknowledged).length;
    const medium = alerts.filter(a => a.severity === 'medium' && !a.acknowledged).length;
    const low = alerts.filter(a => a.severity === 'low' && !a.acknowledged).length;

    return {
      summary: { critical, high, medium, low, total: alerts.length },
      recentAlerts: alerts.slice(0, 5),
    };
  });

}

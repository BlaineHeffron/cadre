import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { cadreEnvName, withCadreEnv } from '../platform/cadre-env.mjs';

const DEFAULT_GRACE_MS = 500;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms)));
}

export function readProcessStartTime(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${numeric}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ? String(fields[19]) : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid, processStartTime = null) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
  } catch {
    return false;
  }
  return processStartTime == null || processStartTime === ''
    ? true
    : readProcessStartTime(numeric) === String(processStartTime);
}

export function signalProcessGroup(pgid, signal) {
  const numeric = Number(pgid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(-numeric, signal);
    return true;
  } catch {
    return false;
  }
}

export function isProcessGroupAlive(pgid) {
  const numeric = Number(pgid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(-numeric, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalPid(pid, signal) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, signal);
    return true;
  } catch {
    return false;
  }
}

function signalContainment(instance, signal) {
  return signalProcessGroup(instance?.containment?.pgid, signal)
    || signalPid(instance?.pid, signal);
}

function containmentAlive(instance) {
  return isProcessAlive(instance?.pid, instance?.processStartTime)
    || isProcessGroupAlive(instance?.containment?.pgid);
}

function processIdentityMismatch(instance) {
  if (!instance?.pid || !instance?.processStartTime) return false;
  const observed = readProcessStartTime(instance.pid);
  return observed != null && observed !== String(instance.processStartTime);
}

function residualFor(instance, reason = undefined) {
  return {
    instanceId: instance.instanceId,
    pid: instance.pid || null,
    pgid: instance.containment?.pgid || null,
    processStartTime: instance.processStartTime || null,
    ...(reason ? { reason } : {}),
  };
}

function normalizeLedger(raw) {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

function structuredEntry(entry) {
  if (entry?.kind === 'tmux' || entry?.driver === 'tmux') return false;
  if (entry?.kind === 'structured') return true;
  if (['deepseek-acp', 'acp', 'claude-stream-json'].includes(entry?.driver)) return true;
  // Migration for the private DeepSeek P0 ledger. A legacy entry is only
  // recognized when it carries the DeepSeek session-root marker; an arbitrary
  // PID record is never assumed to be Fleet-owned.
  return !entry?.kind && !entry?.driver && Boolean(entry?.sessionRoot);
}

function withinRoot(path, root) {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

export function buildSupervisedEnv(sourceEnv = {}, allowedKeys = []) {
  const result = {};
  for (const key of new Set(allowedKeys.flatMap((key) => [cadreEnvName(key), String(key)]))) {
    if (sourceEnv[key] != null && sourceEnv[key] !== '') result[key] = String(sourceEnv[key]);
  }
  return result;
}

async function findProcessesByInstanceMarker(instanceId) {
  const marker = `DUENO_RUNTIME_INSTANCE_ID=${String(instanceId)}`;
  let names = [];
  try {
    names = await readdir('/proc');
  } catch {
    return [];
  }
  const matches = [];
  await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    try {
      const environ = await readFile(`/proc/${name}/environ`);
      const values = environ.toString('utf8').split('\0');
      if (values.includes(marker)) {
        const pid = Number(name);
        matches.push({ pid, processStartTime: readProcessStartTime(pid) });
      }
    } catch {
      // Processes can exit while /proc is scanned and foreign processes may
      // deny environ reads. Neither condition grants permission to kill them.
    }
  }));
  return matches.sort((left, right) => left.pid - right.pid);
}

export class ProcessSupervisor {
  constructor({
    ledgerPath = null,
    spawnImpl = nodeSpawn,
    cwdRoots = [],
    now = () => Date.now(),
    onOrphanReaped = () => {},
    spawnTimeoutMs = 5_000,
  } = {}) {
    this.ledgerPath = ledgerPath ? resolve(ledgerPath) : null;
    this.spawnImpl = spawnImpl;
    this.cwdRoots = cwdRoots.map((root) => resolve(root));
    this.now = now;
    this.onOrphanReaped = onOrphanReaped;
    this.spawnTimeoutMs = Math.max(1, Number(spawnTimeoutMs) || 5_000);
    this.instances = new Map();
    this.entries = [];
    this.initialized = false;
    this.writeChain = Promise.resolve();
    this.lastReapReport = [];
  }

  async init({ reap = true } = {}) {
    if (this.initialized) return this.lastReapReport;
    this.entries = await this.#readLedger();
    this.initialized = true;
    if (reap) this.lastReapReport = await this.reapOrphans();
    return clone(this.lastReapReport);
  }

  runtime(instanceId) {
    const runtime = this.instances.get(String(instanceId || ''));
    if (!runtime) return null;
    const { child: _child, ...publicRuntime } = runtime;
    return clone(publicRuntime);
  }

  list() {
    return [...this.instances.keys()].map((id) => this.runtime(id));
  }

  async spawn({
    instanceId = randomUUID(),
    driver,
    driverVersion = '',
    command,
    args = [],
    cwd,
    env = {},
    allowedEnvKeys = [],
    negotiated = null,
    metadata = {},
    stdio = ['pipe', 'pipe', 'pipe'],
  } = {}) {
    await this.init();
    const id = String(instanceId || '').trim();
    if (!id) throw new TypeError('instanceId is required');
    if (this.instances.has(id) || this.entries.some((entry) => entry.instanceId === id)) {
      throw new Error(`Runtime instance already exists: ${id}`);
    }
    if (!String(driver || '').trim()) throw new TypeError('driver is required');
    if (!String(command || '').trim()) throw new TypeError('command is required');
    const absoluteCwd = this.#validateCwd(cwd);
    const createdAt = this.now();
    const provisioning = {
      instanceId: id,
      kind: 'structured',
      driver: String(driver),
      driverVersion: String(driverVersion || ''),
      containment: { type: 'process_group', pgid: null },
      pid: null,
      processStartTime: null,
      connection: 'provisioning',
      negotiated: clone(negotiated),
      lifecycle: 'provisioning',
      refcount: 1,
      cwd: absoluteCwd,
      createdAt,
      metadata: clone(metadata || {}),
    };

    // This durable intent closes the crash window before child creation. The
    // following bind replaces the same entry atomically once pid/starttime exist.
    this.entries.push(provisioning);
    await this.#persistLedger();

    let child;
    try {
      child = this.spawnImpl(String(command), args.map(String), {
        cwd: absoluteCwd,
        env: {
          ...buildSupervisedEnv(env, allowedEnvKeys),
          ...withCadreEnv({ DUENO_RUNTIME_INSTANCE_ID: id }),
        },
        stdio,
        detached: true,
      });
    } catch (error) {
      await this.#removeEntry(id);
      throw error;
    }

    const pid = Number.isInteger(Number(child?.pid)) && Number(child.pid) > 0 ? Number(child.pid) : null;
    const spawnFailure = pid ? null : Promise.race([
      new Promise((resolveFailure) => {
        child.once?.('error', (error) => resolveFailure(error));
      }),
      delay(this.spawnTimeoutMs).then(() => Object.assign(new Error('spawn produced no pid'), { code: 'spawn_no_pid' })),
    ]);
    const runtime = {
      ...provisioning,
      containment: { type: 'process_group', pgid: pid },
      pid,
      processStartTime: readProcessStartTime(pid),
      connection: 'starting',
      lifecycle: 'starting',
      child,
    };
    this.instances.set(id, runtime);

    const markExited = (info) => {
      if (runtime.lifecycle === 'exited') return;
      runtime.connection = 'closed';
      runtime.lifecycle = 'exited';
      runtime.exit = { ...info, at: this.now() };
      if (isProcessGroupAlive(runtime.containment?.pgid)) {
        this.#replaceEntry(runtime).catch(() => {});
      } else {
        this.#removeEntry(id).catch(() => {});
      }
    };
    child.once?.('error', (error) => markExited({ code: error?.code || null, signal: null, error: error?.message || String(error) }));
    child.once?.('exit', (code, signal) => markExited({ code, signal }));
    await this.#replaceEntry(runtime);
    if (spawnFailure) {
      const error = await spawnFailure;
      await this.#removeEntry(id);
      throw error;
    }
    return { ...this.runtime(id), child };
  }

  markConnection(instanceId, connection, negotiated = undefined) {
    const runtime = this.instances.get(String(instanceId || ''));
    if (!runtime) return false;
    runtime.connection = String(connection || 'unknown');
    if (negotiated !== undefined) runtime.negotiated = clone(negotiated);
    if (runtime.lifecycle === 'starting' && connection === 'open') runtime.lifecycle = 'running';
    this.#replaceEntry(runtime).catch(() => {});
    return true;
  }

  async terminate(instanceOrId, { graceMs = DEFAULT_GRACE_MS } = {}) {
    await this.init({ reap: false });
    const runtime = typeof instanceOrId === 'string'
      ? this.instances.get(instanceOrId)
      : instanceOrId?.child
        ? instanceOrId
        : this.instances.get(instanceOrId?.instanceId) || instanceOrId;
    if (!runtime?.instanceId) {
      return { ok: true, status: 'already_gone', residual: [] };
    }
    const alive = () => containmentAlive(runtime);
    if (processIdentityMismatch(runtime) && isProcessGroupAlive(runtime.containment?.pgid)) {
      runtime.connection = 'closed';
      runtime.lifecycle = 'failed';
      await this.#replaceEntry(runtime);
      return { ok: false, status: 'failed', residual: [residualFor(runtime, 'process_identity_mismatch')] };
    }
    if (!alive()) {
      this.instances.delete(runtime.instanceId);
      await this.#removeEntry(runtime.instanceId);
      return { ok: true, status: 'already_gone', residual: [] };
    }
    runtime.connection = 'closing';
    runtime.lifecycle = 'terminating';
    signalContainment(runtime, 'SIGTERM');
    await this.#waitUntilGone(runtime, graceMs);
    if (alive()) {
      signalContainment(runtime, 'SIGKILL');
      await this.#waitUntilGone(runtime, Math.max(200, graceMs));
    }
    const residual = alive() ? [residualFor(runtime)] : [];
    if (residual.length) {
      runtime.connection = 'closed';
      runtime.lifecycle = 'failed';
      await this.#replaceEntry(runtime);
      return { ok: false, status: 'failed', residual };
    }
    runtime.connection = 'closed';
    runtime.lifecycle = 'exited';
    this.instances.delete(runtime.instanceId);
    await this.#removeEntry(runtime.instanceId);
    return { ok: true, status: 'terminated', residual: [] };
  }

  async reapOrphans() {
    if (!this.initialized) await this.init({ reap: false });
    const report = [];
    const keep = [];
    for (const entry of this.entries) {
      if (!structuredEntry(entry)) {
        keep.push(entry);
        continue;
      }
      if (this.instances.has(entry.instanceId)) {
        keep.push(entry);
        continue;
      }
      if (!entry.pid && entry.lifecycle === 'provisioning') {
        const matches = await findProcessesByInstanceMarker(entry.instanceId || entry.id);
        if (!matches.length) {
          const verdict = {
            instanceId: entry.instanceId || entry.id,
            ok: false,
            status: 'failed',
            residual: [{
              instanceId: entry.instanceId || entry.id,
              pid: null,
              pgid: null,
              reason: 'provisioning_unresolved',
            }],
          };
          report.push(verdict);
          keep.push(entry);
          this.onOrphanReaped(clone(verdict), clone(entry));
          continue;
        }
        for (const match of matches) {
          signalProcessGroup(match.pid, 'SIGTERM') || signalPid(match.pid, 'SIGTERM');
        }
        await delay(DEFAULT_GRACE_MS);
        for (const match of matches) {
          if (isProcessAlive(match.pid, match.processStartTime)) {
            signalProcessGroup(match.pid, 'SIGKILL') || signalPid(match.pid, 'SIGKILL');
          }
        }
        await delay(DEFAULT_GRACE_MS);
        const residual = matches
          .filter((match) => isProcessAlive(match.pid, match.processStartTime))
          .map((match) => ({
            instanceId: entry.instanceId || entry.id,
            pid: match.pid,
            pgid: match.pid,
            processStartTime: match.processStartTime,
          }));
        const verdict = {
          instanceId: entry.instanceId || entry.id,
          ok: residual.length === 0,
          status: residual.length ? 'failed' : 'terminated',
          residual,
        };
        report.push(verdict);
        this.onOrphanReaped(clone(verdict), clone(entry));
        if (residual.length) keep.push(entry);
        continue;
      }
      const entryRuntime = {
        ...entry,
        instanceId: entry.instanceId || entry.id,
        containment: entry.containment || { type: 'process_group', pgid: entry.pgid || entry.pid },
      };
      if (processIdentityMismatch(entryRuntime) && isProcessGroupAlive(entryRuntime.containment?.pgid)) {
        const verdict = {
          instanceId: entryRuntime.instanceId,
          ok: false,
          status: 'failed',
          residual: [residualFor(entryRuntime, 'process_identity_mismatch')],
        };
        report.push(verdict);
        keep.push(entry);
        this.onOrphanReaped(clone(verdict), clone(entry));
        continue;
      }
      if (!entry.pid || !containmentAlive(entryRuntime)) {
        report.push({ instanceId: entry.instanceId || entry.id, ok: true, status: 'already_gone', residual: [] });
        continue;
      }
      const runtime = {
        ...entry,
        instanceId: entry.instanceId || entry.id,
        containment: entry.containment || { type: 'process_group', pgid: entry.pgid || entry.pid },
      };
      signalContainment(runtime, 'SIGTERM');
      await this.#waitUntilGone(runtime, DEFAULT_GRACE_MS);
      if (containmentAlive(runtime)) {
        signalContainment(runtime, 'SIGKILL');
        await this.#waitUntilGone(runtime, DEFAULT_GRACE_MS);
      }
      const residual = containmentAlive(runtime)
        ? [residualFor(runtime)]
        : [];
      const verdict = {
        instanceId: runtime.instanceId,
        ok: residual.length === 0,
        status: residual.length ? 'failed' : 'terminated',
        residual,
      };
      report.push(verdict);
      this.onOrphanReaped(clone(verdict), clone(entry));
      if (residual.length) keep.push(entry);
    }
    this.entries = keep;
    await this.#persistLedger();
    this.lastReapReport = report;
    return clone(report);
  }

  async close({ terminate = false, graceMs = DEFAULT_GRACE_MS } = {}) {
    if (terminate) {
      await Promise.allSettled([...this.instances.keys()].map((id) => this.terminate(id, { graceMs })));
    }
    await this.writeChain;
  }

  #validateCwd(cwd) {
    const absolute = String(cwd || '').trim();
    if (!isAbsolute(absolute)) throw new Error('Supervised process cwd must be absolute');
    if (!existsSync(absolute)) throw new Error(`Supervised process cwd does not exist: ${absolute}`);
    if (this.cwdRoots.length && !this.cwdRoots.some((root) => withinRoot(absolute, root))) {
      throw new Error(`Supervised process cwd is outside allowed roots: ${absolute}`);
    }
    return resolve(absolute);
  }

  async #waitUntilGone(runtime, timeoutMs) {
    const deadline = this.now() + Math.max(0, Number(timeoutMs) || 0);
    while (containmentAlive(runtime) && this.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - this.now())));
    }
    return !containmentAlive(runtime);
  }

  async #readLedger() {
    if (!this.ledgerPath) return [];
    try {
      return normalizeLedger(JSON.parse(await readFile(this.ledgerPath, 'utf8')));
    } catch {
      return [];
    }
  }

  #serialWrite(operation) {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async #persistLedger() {
    if (!this.ledgerPath) return;
    const snapshot = this.entries.map((entry) => {
      const { child: _child, ...stored } = entry;
      return stored;
    });
    await this.#serialWrite(async () => {
      await mkdir(dirname(this.ledgerPath), { recursive: true });
      const tempPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify({ version: 1, entries: snapshot }, null, 2)}\n`, { mode: 0o600 });
      const fileHandle = await open(tempPath, 'r');
      try { await fileHandle.sync(); } finally { await fileHandle.close(); }
      await rename(tempPath, this.ledgerPath);
      const directoryHandle = await open(dirname(this.ledgerPath), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    });
  }

  async #replaceEntry(runtime) {
    const { child: _child, ...stored } = runtime;
    const index = this.entries.findIndex((entry) => (entry.instanceId || entry.id) === runtime.instanceId);
    if (index < 0) this.entries.push(stored);
    else this.entries[index] = stored;
    await this.#persistLedger();
  }

  async #removeEntry(instanceId) {
    this.entries = this.entries.filter((entry) => (entry.instanceId || entry.id) !== instanceId);
    await this.#persistLedger();
  }
}

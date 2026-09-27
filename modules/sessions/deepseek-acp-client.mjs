import { AcpTransport } from '../agent/acp-transport.mjs';
import {
  isProcessAlive,
  isProcessGroupAlive,
  readProcessStartTime,
  signalPid,
  signalProcessGroup,
} from '../agent/process-supervisor.mjs';

export { isProcessAlive, isProcessGroupAlive, readProcessStartTime, signalPid, signalProcessGroup };

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEEPSEEK_ACP_START_TIMEOUT_MS = 60_000;
export const DEEPSEEK_ACP_MAX_STDOUT_BUFFER = 8 * 1024 * 1024;

// Compatibility binding for P0 callers. Framing, process ownership, events,
// and capabilities all live in the shared transport/supervisor stack.
export class DeepSeekAcpClient {
  constructor(options = {}) {
    this.transport = new AcpTransport({
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      startTimeoutMs: options.startTimeoutMs ?? DEEPSEEK_ACP_START_TIMEOUT_MS,
      maxFrameBytes: options.maxFrameBytes ?? options.maxStdoutBuffer ?? DEEPSEEK_ACP_MAX_STDOUT_BUFFER,
    });
  }

  get child() { return this.transport.child; }
  get pid() { return this.transport.pid; }
  get pgid() { return this.transport.pgid; }
  get processStartTime() { return this.transport.processStartTime; }
  get sessionId() { return this.transport.protocolSessionId; }
  get connectionState() { return this.transport.closed ? 'closed' : this.transport.codec ? 'open' : 'closed'; }
  get closed() { return this.transport.closed; }
  get openPermissionIds() { return new Set([...this.transport.interactions.values()].map((item) => item.requestId)); }

  async start(sessionCwd) {
    const started = await this.transport.start({ cwd: sessionCwd });
    return started.protocolSessionId;
  }

  request(method, params = {}, options = {}) {
    return this.transport.request(method, params, options);
  }

  prompt(text) {
    return this.transport.prompt({ blocks: [{ type: 'text', text: String(text || '') }] });
  }

  cancel() {
    this.transport.cancel({ turnId: this.transport.currentTurn?.turnId }).catch(() => {});
    return Boolean(this.transport.protocolSessionId && !this.transport.closed);
  }

  async answerPermission(requestId, optionId) {
    const entry = [...this.transport.interactions.values()].find((item) => item.requestId === requestId);
    if (!entry) return false;
    return this.transport.answerInteraction({ interactionId: entry.interactionId, optionId }).then(() => true, () => false);
  }

  async cancelPermission(requestId) {
    const entry = [...this.transport.interactions.values()].find((item) => item.requestId === requestId);
    return entry ? this.transport.cancelInteraction(entry.interactionId) : false;
  }

  cancelAllPermissions() { return this.transport.cancelAllInteractions(); }

  async close({ graceMs = 500 } = {}) {
    return this.transport.terminate({ grace: graceMs });
  }
}

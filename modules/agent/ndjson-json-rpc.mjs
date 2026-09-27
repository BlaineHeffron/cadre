import { EventEmitter } from 'node:events';

export const DEFER_JSON_RPC_RESPONSE = Symbol('defer-json-rpc-response');
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

function rpcError(message, code = 'transport_error', data = undefined) {
  const error = message instanceof Error ? message : new Error(String(message || 'JSON-RPC transport failed'));
  if (!error.code) error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

export class NdjsonJsonRpcCodec extends EventEmitter {
  constructor({
    readable,
    writable,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    requestTimeoutMs = 30_000,
    onRequest = null,
    onNotification = null,
    onDiagnostic = () => {},
    omitJsonrpc = false,
  } = {}) {
    super();
    if (!readable || !writable) throw new TypeError('readable and writable streams are required');
    this.readable = readable;
    this.writable = writable;
    this.maxFrameBytes = Number(maxFrameBytes);
    this.requestTimeoutMs = Number(requestTimeoutMs);
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onDiagnostic = onDiagnostic;
    this.omitJsonrpc = omitJsonrpc;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.buffer = Buffer.alloc(0);
    this.state = 'open';
    this.terminalError = null;
    this.writeChain = Promise.resolve();

    readable.on('data', (chunk) => this.#consume(chunk));
    readable.once('end', () => this.close(rpcError('JSON-RPC readable ended', 'transport_eof')));
    readable.once('close', () => this.close(rpcError('JSON-RPC readable closed', 'transport_closed')));
    readable.once('error', (error) => this.close(rpcError(error, 'transport_read_error')));
    writable.once('error', (error) => this.close(rpcError(error, 'transport_write_error')));
  }

  get closed() {
    return this.state === 'closed';
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs, onWritten = null } = {}) {
    if (this.closed) return Promise.reject(this.terminalError || rpcError('JSON-RPC codec is closed'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = Number(timeoutMs) > 0 ? setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        const error = rpcError(`JSON-RPC request timed out: ${method}`, 'request_timeout');
        error.method = method;
        entry.reject(error);
      }, Number(timeoutMs)) : null;
      timer?.unref?.();
      this.pending.set(id, { method, resolve, reject, timer, written: false, response: null });
      this.write({ jsonrpc: '2.0', id, method, params })
        .then(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          entry.written = true;
          if (typeof onWritten === 'function') onWritten({ id, method });
          if (entry.response) this.#settleResponse(id, entry, entry.response);
        })
        .catch((error) => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(error);
        });
    });
  }

  notify(method, params = {}) {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    return this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message, data = undefined) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return this.write({ jsonrpc: '2.0', id, error });
  }

  write(message) {
    if (this.closed) return Promise.reject(this.terminalError || rpcError('JSON-RPC codec is closed'));
    let payload;
    try {
      if (this.omitJsonrpc) { const { jsonrpc: _version, ...frame } = message; message = frame; }
      payload = Buffer.from(`${JSON.stringify(message)}\n`);
    } catch (error) {
      return Promise.reject(rpcError(error, 'serialization_error'));
    }
    if (payload.byteLength - 1 > this.maxFrameBytes) {
      return Promise.reject(rpcError('JSON-RPC outbound frame exceeded limit', 'frame_oversize'));
    }
    const operation = () => this.#writePayload(payload);
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.catch(() => {});
    return result;
  }

  close(reason = rpcError('JSON-RPC codec closed', 'transport_closed')) {
    if (this.closed) return false;
    this.state = 'closed';
    this.terminalError = rpcError(reason);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(this.terminalError);
    }
    this.emit('close', this.terminalError);
    return true;
  }

  #writePayload(payload) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.writable?.writable) {
        reject(this.terminalError || rpcError('JSON-RPC writable is unavailable', 'transport_not_writable'));
        return;
      }
      let callbackDone = false;
      let drainDone = true;
      let settled = false;
      const cleanup = () => {
        this.writable.off?.('drain', onDrain);
        this.writable.off?.('error', onError);
      };
      const finish = () => {
        if (settled || !callbackDone || !drainDone) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const fail = (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = rpcError(cause, 'transport_write_error');
        this.close(error);
        reject(error);
      };
      const onDrain = () => {
        drainDone = true;
        finish();
      };
      const onError = (error) => fail(error);
      this.writable.once?.('error', onError);
      try {
        const accepted = this.writable.write(payload, (error) => {
          if (error) {
            fail(error);
            return;
          }
          callbackDone = true;
          finish();
        });
        if (!accepted) {
          drainDone = false;
          this.writable.once?.('drain', onDrain);
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  #consume(chunk) {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.byteLength > this.maxFrameBytes && this.buffer.indexOf(0x0a) < 0) {
      const error = rpcError('JSON-RPC frame had no newline before limit', 'frame_no_newline');
      this.onDiagnostic(error.message);
      this.close(error);
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      if (frame.byteLength > this.maxFrameBytes) {
        const error = rpcError('JSON-RPC frame exceeded limit', 'frame_oversize');
        this.onDiagnostic(error.message);
        this.close(error);
        return;
      }
      let message;
      try {
        message = JSON.parse(frame.toString('utf8'));
      } catch (cause) {
        const error = rpcError(`Malformed JSON-RPC frame: ${cause.message}`, 'malformed_frame');
        this.onDiagnostic(error.message);
        this.close(error);
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        const error = rpcError('Malformed JSON-RPC message', 'malformed_frame');
        this.onDiagnostic(error.message);
        this.close(error);
        return;
      }
      this.#handle(message).catch((error) => {
        this.onDiagnostic(`JSON-RPC handler failed: ${error.message}`);
      });
    }
  }

  async #handle(message) {
    if (message.id !== undefined && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) return; // Late/unknown response ids are explicitly tolerated.
      if (!entry.written) {
        entry.response = message;
        return;
      }
      this.#settleResponse(message.id, entry, message);
      return;
    }

    if (!message.method) return;
    if (message.id === undefined) {
      if (typeof this.onNotification === 'function') await this.onNotification(message.method, message.params || {}, message);
      this.emit('notification', message);
      return;
    }

    if (typeof this.onRequest !== 'function') {
      await this.respondError(message.id, -32601, `Method not found: ${message.method}`);
      return;
    }
    let result;
    try {
      result = await this.onRequest(message.method, message.params || {}, message);
    } catch (error) {
      await this.respondError(message.id, error?.code || -32603, error?.message || 'Internal error', error?.data);
      return;
    }
    if (result === DEFER_JSON_RPC_RESPONSE) return;
    if (result === undefined) {
      await this.respondError(message.id, -32601, `Method not found: ${message.method}`);
      return;
    }
    await this.respond(message.id, result);
  }

  #settleResponse(id, entry, message) {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) {
      const error = rpcError(message.error.message || `JSON-RPC ${entry.method} failed`, message.error.code);
      error.data = message.error.data;
      error.responseReceived = true;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  }
}

#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';

const server = createDefaultAgentBusMcpServer(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = resolve(repoRoot, 'logs');
const logFile = resolve(logDir, 'agent-bus-mcp.log');

let buffer = Buffer.alloc(0);
let sawInput = false;

function logLine(line) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore logging failures
  }
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, payload]));
}

async function handleFrame(frame) {
  let message;
  try {
    message = JSON.parse(frame.toString('utf8'));
  } catch (err) {
    logLine(`invalid-json ${err.message}`);
    writeMessage({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Invalid JSON: ${err.message}` },
    });
    return;
  }

  logLine(`request ${message.method || 'unknown'}`);

  const response = await server.handleRequest(message);
  if (response) writeMessage(response);
}

function consumeFrames() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }

    const length = Number(match[1]);
    const frameStart = headerEnd + 4;
    if (buffer.length < frameStart + length) return;

    const frame = buffer.slice(frameStart, frameStart + length);
    buffer = buffer.slice(frameStart + length);
    handleFrame(frame).catch((err) => {
      logLine(`error ${err.message || 'Unhandled MCP server error'}`);
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: err.message || 'Unhandled MCP server error' },
      });
    });
  }
}

process.stdin.on('data', (chunk) => {
  sawInput = true;
  logLine(`stdin-bytes ${chunk.length}`);
  buffer = Buffer.concat([buffer, chunk]);
  consumeFrames();
});

logLine('server-start');
process.stdin.resume();
process.stdin.on('end', () => {
  logLine(`stdin-end sawInput=${sawInput}`);
  process.exit(0);
});
process.stdin.on('close', () => {
  logLine(`stdin-close sawInput=${sawInput}`);
});
process.on('exit', (code) => {
  logLine(`process-exit code=${code} sawInput=${sawInput}`);
});

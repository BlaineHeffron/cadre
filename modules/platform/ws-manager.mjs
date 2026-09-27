/**
 * WebSocket Manager — multiplexed channels over a single WS connection.
 *
 * Protocol:
 *   Client → Server: { action: "subscribe", channel: "tmux:pane:0" }
 *   Client → Server: { action: "unsubscribe", channel: "tmux:pane:0" }
 *   Client → Server: { action: "message", channel: "tmux:pane:0", data: {...} }
 *   Server → Client: { channel: "tmux:pane:0", type: "data", data: {...} }
 */

import { config } from '../../config.mjs';
import {
  BROWSER_SESSION_COOKIE,
  parseCookies,
  verifyBrowserSessionCookie,
  verifyToken,
} from './auth.mjs';
import { queueControlEvent } from '../ops/control-events.mjs';

export function resolveWebSocketAuth(req, {
  allowQueryToken = config.auth.wsQueryTokenCompat,
} = {}) {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return { token: authHeader.slice(7), source: 'authorization', deprecated: false };
  }

  const cookies = parseCookies(req.headers?.cookie || '');
  if (cookies[BROWSER_SESSION_COOKIE]) {
    const sessionValid = verifyBrowserSessionCookie(cookies[BROWSER_SESSION_COOKIE]);
    if (sessionValid) {
      return {
        token: '',
        source: 'session_cookie',
        deprecated: false,
        sessionValid,
      };
    }
  }

  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (!queryToken) {
    return { token: '', source: 'none', deprecated: false };
  }
  if (!allowQueryToken) {
    return { token: '', source: 'query', deprecated: true, rejected: true };
  }
  return { token: queryToken, source: 'query', deprecated: true };
}

export function redactedWebSocketAuthDetail(req) {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('token')) url.searchParams.set('token', '[redacted]');
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

export class WsManager {
  constructor(app) {
    this.app = app;
    /** @type {Map<string, Set<import('ws').WebSocket>>} channel → clients */
    this.channels = new Map();
    /** @type {Map<import('ws').WebSocket, Set<string>>} client → subscribed channels */
    this.clientChannels = new Map();
    /** @type {Map<string, function>} channel → handler for incoming messages */
    this.handlers = new Map();

    this._registerRoute();
  }

  _registerRoute() {
    this.app.get('/ws', { websocket: true }, (socket, req) => {
      const auth = resolveWebSocketAuth(req);
      const token = auth.token;

      if (!auth.sessionValid && !verifyToken(token)) {
        if (auth.source === 'query' && auth.rejected) {
          queueControlEvent({
            type: 'ws_query_token',
            severity: 'warning',
            module: 'ws',
            action: 'handshake_auth',
            outcome: 'rejected',
            code: 'ws.query_token_rejected',
            detail: redactedWebSocketAuthDetail(req),
            message: 'Rejected deprecated WebSocket query-token auth',
            metadata: {
              ip: req.ip || req.raw?.socket?.remoteAddress || '',
            },
          }, (error) => this.app.log.warn({ err: error }, 'Failed to persist WebSocket control event'));
          this.app.log.warn({
            control_event: {
              type: 'ws_query_token_rejected',
              ip: req.ip || req.raw?.socket?.remoteAddress || '',
            },
          }, 'Rejected deprecated WebSocket query-token auth');
        }
        socket.close(4001, 'Unauthorized');
        return;
      }
      if (auth.deprecated) {
        queueControlEvent({
          type: 'ws_query_token',
          severity: 'warning',
          module: 'ws',
          action: 'handshake_auth',
          outcome: 'deprecated',
          code: 'ws.query_token_deprecated',
          detail: redactedWebSocketAuthDetail(req),
          message: 'WebSocket query-token auth is deprecated',
          metadata: {
            ip: req.ip || req.raw?.socket?.remoteAddress || '',
          },
        }, (error) => this.app.log.warn({ err: error }, 'Failed to persist WebSocket control event'));
        this.app.log.warn({
          control_event: {
            type: 'ws_query_token_deprecated',
            ip: req.ip || req.raw?.socket?.remoteAddress || '',
          },
        }, 'WebSocket query-token auth is deprecated');
      }

      this.clientChannels.set(socket, new Set());

      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(socket, msg);
        } catch {
          socket.send(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });

      socket.on('close', () => {
        const subs = this.clientChannels.get(socket);
        if (subs) {
          for (const ch of subs) {
            const clients = this.channels.get(ch);
            if (clients) {
              clients.delete(socket);
              if (clients.size === 0) this.channels.delete(ch);
            }
          }
        }
        this.clientChannels.delete(socket);
      });
    });
  }

  _handleMessage(socket, msg) {
    const { action, channel, data } = msg;

    if (action === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', data: { ts: msg.ts || Date.now() } }));
      return;
    }

    if (!channel) {
      socket.send(JSON.stringify({ error: 'Missing channel' }));
      return;
    }

    switch (action) {
      case 'subscribe':
        if (!this.channels.has(channel)) this.channels.set(channel, new Set());
        this.channels.get(channel).add(socket);
        this.clientChannels.get(socket)?.add(channel);
        socket.send(JSON.stringify({ channel, type: 'subscribed' }));
        {
          const handler = this.handlers.get(channel) ?? this.handlers.get(channel.split(':')[0]);
          if (handler) {
            handler(socket, channel, { action: 'subscribe', ...data });
          }
        }
        break;

      case 'unsubscribe':
        this.channels.get(channel)?.delete(socket);
        this.clientChannels.get(socket)?.delete(channel);
        socket.send(JSON.stringify({ channel, type: 'unsubscribed' }));
        {
          const handler = this.handlers.get(channel) ?? this.handlers.get(channel.split(':')[0]);
          if (handler) {
            handler(socket, channel, { action: 'unsubscribe' });
          }
        }
        break;

      case 'message':
        // Route to registered handler
        const handler = this.handlers.get(channel) ?? this.handlers.get(channel.split(':')[0]);
        if (handler) {
          handler(socket, channel, data);
        }
        break;
    }
  }

  /**
   * Register a handler for a channel prefix.
   * @param {string} channelPrefix — e.g., 'tmux', 'threats'
   * @param {function(socket, channel, data)} handler
   */
  onChannel(channelPrefix, handler) {
    this.handlers.set(channelPrefix, handler);
  }

  /**
   * Broadcast data to all subscribers of a channel.
   * @param {string} channel
   * @param {string} type — message type
   * @param {*} data — payload
   */
  broadcast(channel, type, data) {
    const clients = this.channels.get(channel);
    if (!clients) return;

    const msg = JSON.stringify({ channel, type, data });
    for (const client of clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    }
  }

  /**
   * Send data to a single client on a channel.
   */
  send(socket, channel, type, data) {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ channel, type, data }));
    }
  }
}

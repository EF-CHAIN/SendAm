import { getToken } from './auth';

/**
 * WebSocketManager
 * Provides resilient, auto-reconnecting WebSocket client with exponential backoff,
 * jitter, ping/pong heartbeat detection, and connection state management.
 */
export class WebSocketManager {
  constructor(url, options = {}) {
    this.url = url || this.getDefaultUrl();
    this.options = {
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30000,
      heartbeatIntervalMs: 25000,
      heartbeatTimeoutMs: 5000,
      ...options,
    };

    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatTimeoutTimer = null;
    this.state = 'disconnected'; // 'connected' | 'reconnecting' | 'disconnected'
    this.listeners = new Map(); // event -> Set of callbacks
    this.stateListeners = new Set();
    this.messageBuffer = [];
    this.isTabActive = typeof document !== 'undefined' ? !document.hidden : true;

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.isTabActive = !document.hidden;
        if (this.isTabActive && this.messageBuffer.length > 0) {
          this.flushBuffer();
        }
      });
    }
  }

  getDefaultUrl() {
    if (typeof window === 'undefined') return 'ws://localhost:3002/ws';
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_WS_URL || `${protocol}//${loc.hostname}:3002/ws`;
    return host;
  }

  connect() {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.updateState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      const token = getToken();
      let wsUrlString = this.url;
      try {
        const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000';
        const wsUrl = new URL(this.url, base);
        if (token) {
          wsUrl.searchParams.set('token', token);
        }
        wsUrlString = wsUrl.toString();
      } catch {
        // Fallback if URL parsing fails
      }

      this.ws = new WebSocket(wsUrlString);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.updateState('connected');
        this.startHeartbeat();
        this.emit('open');
      };

      this.ws.onmessage = (event) => {
        this.resetHeartbeatTimeout();
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'pong') {
            return;
          }
          if (!this.isTabActive) {
            this.messageBuffer.push(data);
          } else {
            this.dispatchMessage(data);
          }
        } catch {
          this.dispatchMessage(event.data);
        }
      };

      this.ws.onclose = (event) => {
        this.stopHeartbeat();
        if (event.code !== 1000) {
          this.scheduleReconnect();
        } else {
          this.updateState('disconnected');
        }
        this.emit('close', event);
      };

      this.ws.onerror = (error) => {
        this.emit('error', error);
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  dispatchMessage(msg) {
    if (msg && typeof msg === 'object' && msg.type) {
      this.emit(msg.type, msg.payload || msg.data || msg);
    }
    this.emit('message', msg);
  }

  flushBuffer() {
    const buffered = [...this.messageBuffer];
    this.messageBuffer = [];
    buffered.forEach((msg) => this.dispatchMessage(msg));
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1))) {
        this.send({ type: 'ping' });
        this.heartbeatTimeoutTimer = setTimeout(() => {
          // Heartbeat timed out, force reconnect
          if (this.ws) {
            this.ws.close();
          }
        }, this.options.heartbeatTimeoutMs);
      }
    }, this.options.heartbeatIntervalMs);
  }

  resetHeartbeatTimeout() {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.resetHeartbeatTimeout();
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    this.updateState('reconnecting');
    if (this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    const base = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectBaseMs * Math.pow(1.5, this.reconnectAttempts - 1)
    );
    // Add jitter: ±20%
    const jitter = base * (0.8 + Math.random() * 0.4);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
  }

  send(data) {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1))) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(payload);
    }
  }

  updateState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      this.stateListeners.forEach((cb) => cb(this.state));
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach((cb) => cb(data));
    }
  }

  onStateChange(callback) {
    this.stateListeners.add(callback);
    callback(this.state);
    return () => this.stateListeners.delete(callback);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.updateState('disconnected');
  }
}

// Global default singleton instance
let defaultWsManager = null;
export function getWebSocketManager() {
  if (!defaultWsManager) {
    defaultWsManager = new WebSocketManager();
  }
  return defaultWsManager;
}

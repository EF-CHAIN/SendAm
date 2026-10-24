/**
 * Multi-tab Session Synchronization and Single-Sign-Out manager
 * using BroadcastChannel API ('sendam_admin_session').
 *
 * Broadcasts and listens for:
 * - AUTH_LOGOUT: Operator logged out or session expired in one tab -> triggers immediate redirect to /login across all open tabs.
 * - AUTH_LOGIN: Operator logged in -> synchronizes tokens and active session across tabs.
 * - TOKEN_REFRESH: Access token or credentials rotated.
 * - PERMISSIONS_UPDATE: Roles or effective permissions modified.
 */

export const SessionEventType = {
  AUTH_LOGOUT: "AUTH_LOGOUT",
  AUTH_LOGIN: "AUTH_LOGIN",
  TOKEN_REFRESH: "TOKEN_REFRESH",
  PERMISSIONS_UPDATE: "PERMISSIONS_UPDATE",
};

const CHANNEL_NAME = "sendam_admin_session";

class SessionBroadcastManager {
  constructor() {
    this.channel = null;
    this.listeners = new Set();
    this._initChannel();
  }

  _initChannel() {
    if (
      typeof window !== "undefined" &&
      typeof window.BroadcastChannel !== "undefined"
    ) {
      try {
        this.channel = new window.BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event) => {
          const { type, payload } = event.data || {};
          if (type) {
            this._notify(type, payload);
          }
        };
      } catch (err) {
        console.warn("BroadcastChannel initialization failed:", err);
      }
    }
  }

  _notify(type, payload) {
    for (const listener of this.listeners) {
      try {
        listener(type, payload);
      } catch (err) {
        console.error("Error in session broadcast listener:", err);
      }
    }
  }

  /**
   * Broadcast an event to all other open tabs.
   *
   * @param {string} type - Event type from SessionEventType
   * @param {Object} [payload={}] - Associated payload data
   */
  broadcast(type, payload = {}) {
    if (this.channel) {
      try {
        this.channel.postMessage({
          type,
          payload,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.warn(`Failed to broadcast ${type}:`, err);
      }
    }
  }

  /**
   * Subscribe to session broadcast messages.
   *
   * @param {Function} callback - (type, payload) => void
   * @returns {Function} unsubscribe function
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Closes the broadcast channel.
   */
  close() {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Channel may already be closed; nothing to do.
      }
      this.channel = null;
    }
    this.listeners.clear();
  }
}

export const sessionBroadcast = new SessionBroadcastManager();

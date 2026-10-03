import axios from 'axios';

/**
 * In-memory queue of pending request descriptors that failed due to network loss.
 * Each entry stores { config, resolve, reject }.
 */
const pendingRetryQueue = [];

// Consumed as source by each Vite app, so import.meta.env resolves in the
// consuming app's build. Set VITE_API_BASE_URL per app (.env).
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3002/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Response interceptor to intercept network-level connectivity failures
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Queue only while the browser reports offline: a queued request settles
    // when the `online` event replays it. If the browser is online, the API is
    // unreachable for another reason — reject so callers can show their error UI.
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const isNetworkError =
      !error.response &&
      isOffline &&
      (error.code === 'ERR_NETWORK' || error.message?.includes('Network Error'));

    // Only queue idempotent queries (GET / HEAD) or explicitly marked retryable requests
    if (isNetworkError && error.config && !error.config._queuedForOfflineRetry) {
      const isIdempotent = ['get', 'head'].includes(
        (error.config.method || 'get').toLowerCase()
      );

      if (isIdempotent) {
        return new Promise((resolve, reject) => {
          error.config._queuedForOfflineRetry = true;
          pendingRetryQueue.push({
            config: error.config,
            resolve,
            reject,
          });
        });
      }
    }

    return Promise.reject(error);
  }
);

/**
 * Returns the number of requests currently queued awaiting network restoration.
 * @returns {number}
 */
export function getPendingRetryCount() {
  return pendingRetryQueue.length;
}

/**
 * Replays all queued requests that failed while offline.
 * @returns {Promise<number>} Number of replayed requests
 */
export async function retryPendingRequests() {
  if (pendingRetryQueue.length === 0) {
    return 0;
  }

  const batch = pendingRetryQueue.splice(0, pendingRetryQueue.length);
  let succeeded = 0;

  for (const item of batch) {
    try {
      delete item.config._queuedForOfflineRetry;
      const res = await api(item.config);
      item.resolve(res);
      succeeded += 1;
    } catch (err) {
      item.reject(err);
    }
  }

  return succeeded;
}

export default api;

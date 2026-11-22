import { setupWorker } from 'msw/browser';
import { handlers } from './handlers.js';

export const worker = setupWorker(...handlers);

/**
 * Starts the MSW browser service worker when offline mock mode is enabled.
 * Returns true if the worker started, false otherwise.
 */
export async function startMockWorker({
  enabled = Boolean(import.meta.env?.DEV && import.meta.env?.VITE_USE_MSW === 'true'),
  onUnhandledRequest = 'bypass',
} = {}) {
  if (!enabled) return false;
  await worker.start({ onUnhandledRequest });
  return true;
}

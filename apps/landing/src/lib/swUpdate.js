// Bridges vite-plugin-pwa's registerSW callbacks (wired in main.jsx) to React.
// The service worker never takes over on its own: when a new version is
// installed and waiting, `needRefresh` becomes true and UpdatePrompt asks the
// user; accepting calls the `updateSW` returned by registerSW, which tells the
// waiting worker to activate and reloads the page.

let state = { needRefresh: false, offlineReady: false };
let applyUpdate = null;
const listeners = new Set();

function emit(next) {
  state = { ...state, ...next };
  for (const listener of listeners) listener(state);
}

export const swUpdate = {
  getState: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Called from registerSW's onNeedRefresh with its `updateSW` function. */
  needRefresh(updateSW) {
    applyUpdate = updateSW;
    emit({ needRefresh: true });
  },
  offlineReady() {
    emit({ offlineReady: true });
  },
  /** Activates the waiting worker and reloads. Returns false if none waits. */
  async reload() {
    if (!state.needRefresh || typeof applyUpdate !== 'function') return false;
    await applyUpdate(true);
    return true;
  },
  dismiss() {
    emit({ needRefresh: false, offlineReady: false });
  },
  /** Test helper: forget registered callbacks and listeners. */
  reset() {
    state = { needRefresh: false, offlineReady: false };
    applyUpdate = null;
    listeners.clear();
  },
};

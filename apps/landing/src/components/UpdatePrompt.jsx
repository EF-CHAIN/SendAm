import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { swUpdate } from '@/lib/swUpdate.js';

/**
 * Toast shown when the service worker has downloaded a new version of the
 * site. The old version keeps running until the user chooses to reload.
 */
export default function UpdatePrompt() {
  const [state, setState] = useState(swUpdate.getState);
  const [reloading, setReloading] = useState(false);

  useEffect(() => swUpdate.subscribe(setState), []);

  if (!state.needRefresh) return null;

  const reload = async () => {
    setReloading(true);
    const started = await swUpdate.reload();
    if (!started) setReloading(false);
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby="sw-update-title"
      aria-describedby="sw-update-desc"
      className="fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl sm:inset-x-auto sm:right-4"
    >
      <div className="min-w-0 flex-1">
        <p id="sw-update-title" className="text-sm font-semibold text-dark">
          A new version of SendAm is ready
        </p>
        <p id="sw-update-desc" className="text-xs text-slate-600">
          Reload to get the latest version.
        </p>
      </div>
      <button
        type="button"
        onClick={reload}
        disabled={reloading}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-whatsapp-dark disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <RefreshCw size={14} aria-hidden="true" className={reloading ? 'animate-spin' : undefined} />
        {reloading ? 'Reloading' : 'Reload'}
      </button>
      <button
        type="button"
        onClick={() => swUpdate.dismiss()}
        aria-label="Dismiss update notice"
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

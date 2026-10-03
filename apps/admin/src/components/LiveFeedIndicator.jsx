import { Activity, WifiOff, RefreshCw } from 'lucide-react';

/**
 * LiveFeedIndicator
 * Animated pulse indicator showing live WebSocket connection state and ledger stream status.
 */
export default function LiveFeedIndicator({ state = 'disconnected', onReconnect }) {
  const isConnected = state === 'connected';
  const isReconnecting = state === 'reconnecting' || state === 'connecting';

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold shadow-sm transition-colors bg-white border-slate-200">
      <span className="relative flex h-2 w-2">
        {isConnected && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        )}
        {isReconnecting && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        )}
        <span
          className={`relative inline-flex rounded-full h-2 w-2 ${
            isConnected
              ? 'bg-emerald-500'
              : isReconnecting
              ? 'bg-amber-500'
              : 'bg-rose-500'
          }`}
        />
      </span>

      <span className="text-slate-700 capitalize flex items-center gap-1">
        {isConnected && (
          <>
            <Activity className="w-3.5 h-3.5 text-emerald-600" />
            <span>Live Feed</span>
          </>
        )}
        {isReconnecting && (
          <>
            <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin" />
            <span>Reconnecting...</span>
          </>
        )}
        {!isConnected && !isReconnecting && (
          <>
            <WifiOff className="w-3.5 h-3.5 text-rose-600" />
            <span>Disconnected</span>
          </>
        )}
      </span>

      {!isConnected && onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="text-primary hover:underline ml-1 font-bold focus:outline-none"
          title="Retry connection"
        >
          Retry
        </button>
      )}
    </div>
  );
}

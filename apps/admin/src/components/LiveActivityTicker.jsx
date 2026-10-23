import { useState, useEffect, useCallback, useRef } from 'react';
import { Pause, Play, Sparkles, Send } from 'lucide-react';
import StatusBadge from '@/components/StatusBadge';
import { getWebSocketManager } from '@/lib/websocket';
import useRelativeTime from '@shared/useRelativeTime.js';

const SIMULATED_TEMPLATES = [
  {
    amount: '45.00',
    asset: 'USDC',
    type: 'WhatsApp Voice-to-Cash',
    senderPhone: '+234 803 *** 1294',
    recipientPhone: '+234 812 *** 3341',
    status: 'Completed',
  },
  {
    amount: '25,000',
    asset: 'NGN',
    type: 'P2P Payment Claim',
    senderPhone: '+234 701 *** 8821',
    recipientPhone: '+234 805 *** 7712',
    status: 'Completed',
  },
  {
    amount: '120.00',
    asset: 'XLM',
    type: 'Cross-Border Remittance',
    senderPhone: '+1 415 *** 9821',
    recipientPhone: '+234 913 *** 0029',
    status: 'Completed',
  },
  {
    amount: '85.50',
    asset: 'USDC',
    type: 'Merchant Payout',
    senderPhone: '+234 902 *** 4501',
    recipientPhone: '+234 802 *** 6610',
    status: 'Completed',
  },
  {
    amount: '15,000',
    asset: 'NGN',
    type: 'Airtime Intent',
    senderPhone: '+234 810 *** 5543',
    recipientPhone: '+234 810 *** 5543',
    status: 'Completed',
  },
  {
    amount: '250.00',
    asset: 'USDC',
    type: 'Stellar Settlement',
    senderPhone: '+44 7911 *** 456',
    recipientPhone: '+234 803 *** 9988',
    status: 'Completed',
  },
];

let counter = 0;
const generateSimulatedTransaction = () => {
  counter += 1;
  const template = SIMULATED_TEMPLATES[Math.floor(Math.random() * SIMULATED_TEMPLATES.length)];
  const randomHash = Math.random().toString(16).substring(2, 10);
  return {
    id: `sim-tx-${Date.now()}-${counter}`,
    txHash: randomHash,
    ...template,
    createdAt: new Date().toISOString(),
  };
};

const DEFAULT_INITIAL_ITEMS = [
  {
    id: 'init-1',
    txHash: '3a8f2c91',
    amount: '50.00',
    asset: 'USDC',
    type: 'WhatsApp Voice-to-Cash',
    senderPhone: '+234 803 *** 1294',
    recipientPhone: '+234 812 *** 3341',
    status: 'Completed',
    createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
  },
  {
    id: 'init-2',
    txHash: '7e1b5d44',
    amount: '35,000',
    asset: 'NGN',
    type: 'P2P Payment Claim',
    senderPhone: '+234 701 *** 8821',
    recipientPhone: '+234 805 *** 7712',
    status: 'Completed',
    createdAt: new Date(Date.now() - 90 * 1000).toISOString(),
  },
  {
    id: 'init-3',
    txHash: '9c40aa28',
    amount: '110.00',
    asset: 'XLM',
    type: 'Cross-Border Remittance',
    senderPhone: '+1 415 *** 9821',
    recipientPhone: '+234 913 *** 0029',
    status: 'Completed',
    createdAt: new Date(Date.now() - 180 * 1000).toISOString(),
  },
];

function TickerItemRow({ item }) {
  const timeAgo = useRelativeTime(item.createdAt);
  const isVoice = item.type?.toLowerCase().includes('voice');

  return (
    <li
      data-testid="live-activity-item"
      className="animate-slide-down-fade flex items-center justify-between gap-3 p-3 sm:p-4 rounded-xl bg-gray-50/70 dark:bg-slate-800/50 hover:bg-gray-100/80 dark:hover:bg-slate-800/80 border border-gray-100 dark:border-slate-800/80 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`p-2 rounded-lg shrink-0 ${
            isVoice
              ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
              : 'bg-teal-100 dark:bg-teal-950/60 text-teal-800 dark:text-teal-300'
          }`}
          aria-hidden="true"
        >
          {isVoice ? <Sparkles className="w-4 h-4" /> : <Send className="w-4 h-4" />}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white truncate">
              {item.recipientPhone || item.senderPhone || 'Direct Settlement'}
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200/70 dark:bg-slate-700 text-gray-700 dark:text-gray-300 font-medium">
              {item.type}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
            {item.txHash ? `Hash: ${item.txHash.slice(0, 8)}…` : item.id}
          </p>
        </div>
      </div>

      <div className="text-right shrink-0 flex flex-col items-end gap-1">
        <span className="text-sm font-bold text-slate-900 dark:text-white">
          {item.amount} {item.asset}
        </span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={item.status || 'Completed'} />
          <span className="text-[11px] text-gray-400 dark:text-gray-500">{timeAgo}</span>
        </div>
      </div>
    </li>
  );
}

export default function LiveActivityTicker({
  initialItems,
  maxItems = 8,
  simulateIntervalMs = 4000,
  isSimulated = true,
}) {
  const [items, setItems] = useState(() => initialItems || DEFAULT_INITIAL_ITEMS);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(isPaused);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  const addTransaction = useCallback(
    (newTx) => {
      if (isPausedRef.current || !newTx) return;
      setItems((prev) => [newTx, ...prev.slice(0, maxItems - 1)]);
    },
    [maxItems]
  );

  // Background Simulation Interval
  useEffect(() => {
    if (isPaused || !isSimulated || !simulateIntervalMs || simulateIntervalMs <= 0) {
      return;
    }

    const timer = setInterval(() => {
      addTransaction(generateSimulatedTransaction());
    }, simulateIntervalMs);

    return () => clearInterval(timer);
  }, [isPaused, isSimulated, simulateIntervalMs, addTransaction]);

  // Live WebSocket Real-Time Integration
  useEffect(() => {
    try {
      const wsManager = getWebSocketManager();
      wsManager.connect();

      const handleWsTx = (payload) => {
        if (!payload) return;
        const tx = payload.transaction || payload;
        const normalized = {
          id: tx._id || tx.id || `ws-${Date.now()}`,
          txHash: tx.txHash || (tx._id ? tx._id.slice(0, 8) : 'stellar'),
          amount: tx.amount || '0.00',
          asset: tx.asset || 'USDC',
          type: tx.type || 'WhatsApp Transfer',
          senderPhone: tx.userId?.phoneNumber || tx.senderPhone || '+234 ***',
          recipientPhone: tx.recipientPhoneNumber || tx.destination || 'Direct',
          status: tx.status || 'Completed',
          createdAt: tx.createdAt || new Date().toISOString(),
        };
        addTransaction(normalized);
      };

      const unsubTx = wsManager.on('transaction', handleWsTx);
      const unsubSettled = wsManager.on('transaction_settled', handleWsTx);

      return () => {
        unsubTx();
        unsubSettled();
      };
    } catch {
      // Gracefully handle environments without WebSocket support
    }
  }, [addTransaction]);

  const togglePause = () => {
    setIsPaused((prev) => !prev);
  };

  return (
    <div
      data-testid="live-activity-ticker"
      className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Live Activity</h2>

          {/* Flashing Pulse Dot Status Badge */}
          {!isPaused ? (
            <span
              data-testid="ticker-status-live"
              className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60"
            >
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span>Live</span>
            </span>
          ) : (
            <span
              data-testid="ticker-status-paused"
              className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60"
            >
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" aria-hidden="true" />
              <span>Paused</span>
            </span>
          )}
        </div>

        {/* Dedicated Pause/Resume Control Button */}
        <button
          type="button"
          onClick={togglePause}
          data-testid="ticker-pause-button"
          aria-label={isPaused ? 'Resume live transaction stream' : 'Pause live transaction stream'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary self-start sm:self-auto"
        >
          {isPaused ? (
            <>
              <Play className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 fill-current" aria-hidden="true" />
              <span>Resume</span>
            </>
          ) : (
            <>
              <Pause className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 fill-current" aria-hidden="true" />
              <span>Pause</span>
            </>
          )}
        </button>
      </div>

      {/* Stream Feed Container */}
      <div
        role="region"
        aria-label="Live activity feed"
        aria-live="polite"
        aria-atomic="false"
        className="max-h-[380px] overflow-y-auto pr-0.5"
      >
        {items.length > 0 ? (
          <ul className="space-y-2.5">
            {items.map((item) => (
              <TickerItemRow key={item.id} item={item} />
            ))}
          </ul>
        ) : (
          <p className="text-center py-8 text-sm text-gray-500 dark:text-gray-400">
            No recent activity recorded
          </p>
        )}
      </div>
    </div>
  );
}

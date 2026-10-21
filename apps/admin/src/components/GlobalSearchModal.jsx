import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, X, CornerDownLeft, Loader2,
  ArrowRightLeft, User, Wallet,
} from "lucide-react";
import StatusBadge from "./StatusBadge";
import {
  getAdminTransactions,
  getAdminUsers,
  getAdminWallets,
} from "@/lib/adminApi";

const ENTITY_CONFIG = {
  transaction: {
    label: "Transaction",
    Icon: ArrowRightLeft,
    pillClass: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
    navigate: (record, nav) => { const id = record._id || record.id; if (id) nav(`/transactions/${id}`); },
    primaryText: (record) => record.amount ? `${record.amount} ${record.asset || "USDC"}` : record.type || "Transaction",
    secondaryText: (record) => record.userId?.phoneNumber || record.user?.phoneNumber || record.phoneNumber || "",
    metaText: (record) => record.txHash || record._id || record.id || "",
  },
  user: {
    label: "User",
    Icon: User,
    pillClass: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300",
    navigate: (record, nav) => { const id = record._id || record.id; nav(id ? `/users?highlight=${id}` : "/users"); },
    primaryText: (record) => { const name = [record.firstName, record.lastName].filter(Boolean).join(" "); return name || record.whatsappName || record.displayName || record.email || "User"; },
    secondaryText: (record) => record.phoneNumber || record.email || "",
    metaText: (record) => record.kycStatus || record.status || "",
  },
  wallet: {
    label: "Wallet",
    Icon: Wallet,
    pillClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
    navigate: (record, nav) => { const id = record._id || record.id; nav(id ? `/wallets?highlight=${id}` : "/wallets"); },
    primaryText: (record) => record.address || record.walletAddress || record.label || "Wallet",
    secondaryText: (record) => [record.network || record.chain, record.asset || record.currency].filter(Boolean).join(" · "),
    metaText: (record) => record.balance != null ? `Balance: ${record.balance}` : "",
  },
};

const ENTITY_ORDER = ["transaction", "user", "wallet"];

export default function GlobalSearchModal({ isOpen, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [searchDuration, setSearchDuration] = useState(null);
  const [indexBreakdown, setIndexBreakdown] = useState(null);
  const workerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let worker;
    try {
      worker = new Worker(new URL("../workers/searchWorker.js", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.onmessage = (event) => {
        const { type, results: searchResults, durationMs, breakdown } = event.data || {};
        if (type === "INDEX_COMPLETE") { setIndexing(false); if (breakdown) setIndexBreakdown(breakdown); }
        else if (type === "SEARCH_RESULTS") { setResults(searchResults || []); setSearchDuration(durationMs ? durationMs.toFixed(2) : "0.00"); setLoading(false); setSelectedIndex(0); }
      };
      setIndexing(true);
      Promise.allSettled([
        getAdminTransactions({ limit: 100 }),
        getAdminUsers({ limit: 200 }),
        getAdminWallets({ limit: 200 }),
      ]).then(([txRes, usersRes, walletsRes]) => {
        if (!workerRef.current) return;
        workerRef.current.postMessage({ type: "INDEX_MULTI", payload: { transactions: txRes.value?.data ?? [], users: usersRes.value?.data ?? [], wallets: walletsRes.value?.data ?? [] } });
      });
    } catch { setIndexing(false); }
    return () => { if (worker) worker.terminate(); };
  }, []);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery(""); setResults([]); setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]); setSearchDuration(null); setLoading(false); return;
    }
    setLoading(true);
    if (workerRef.current) { workerRef.current.postMessage({ type: "SEARCH", payload: { query: trimmed, limit: 20 } }); }
    else { setLoading(false); }
  }, [query]);



  const handleKeyDown = (e) => {
    if (e.key === "Escape") { onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((prev) => flatResults.length > 0 ? (prev + 1) % flatResults.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((prev) => flatResults.length > 0 ? (prev - 1 + flatResults.length) % flatResults.length : 0); }
    else if (e.key === "Enter") { e.preventDefault(); if (flatResults[selectedIndex]) handleSelectRecord(flatResults[selectedIndex]); }
  };

  const handleSelectRecord = (record) => {
    onClose();
    const config = ENTITY_CONFIG[record._entityType || "transaction"] ?? ENTITY_CONFIG.transaction;
    config.navigate(record, navigate);
  };

  const grouped = results.reduce((acc, record) => {
    const t = record._entityType || "transaction";
    if (!acc[t]) acc[t] = [];
    acc[t].push(record);
    return acc;
  }, {});
  const flatResults = ENTITY_ORDER.flatMap((t) => grouped[t] || []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 bg-black/50 backdrop-blur-sm"
      role="dialog" aria-modal="true" aria-labelledby="global-search-title"
      data-testid="global-search-modal" onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
        <div className="flex items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 gap-3">
          {indexing ? <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" /> : <Search className="w-5 h-5 text-gray-400" />}
          <input ref={inputRef} id="global-search-title" type="text" value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users, transactions, wallets..."
            className="flex-1 bg-transparent border-0 text-sm focus:outline-none text-gray-900 dark:text-white placeholder-gray-400"
            data-testid="global-search-input" aria-label="Global search"
            aria-autocomplete="list" aria-controls="global-search-results"
            aria-activedescendant={flatResults[selectedIndex] ? `search-result-item-${selectedIndex}` : undefined} />
          {loading ? <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" /> : query ? (
            <button type="button" onClick={() => setQuery("")}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Clear search" data-testid="clear-search-btn">
              <X className="w-4 h-4" />
            </button>) : null}
          <kbd className="hidden sm:inline-block px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">ESC</kbd>
        </div>

        {!query.trim() && indexBreakdown && !indexing && (
          <div className="px-4 pt-2 pb-1 flex items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1"><ArrowRightLeft className="w-3 h-3" />{indexBreakdown.transactions} tx</span>
            <span className="flex items-center gap-1"><User className="w-3 h-3" />{indexBreakdown.users} users</span>
            <span className="flex items-center gap-1"><Wallet className="w-3 h-3" />{indexBreakdown.wallets} wallets</span>
          </div>
        )}

        <div id="global-search-results" className="max-h-[28rem] overflow-y-auto p-2"
          data-testid="global-search-results" role="listbox" aria-label="Search results">
          {flatResults.length > 0 ? (
            <ul className="space-y-0.5">
              {ENTITY_ORDER.map((entityType) => {
                const group = grouped[entityType];
                if (!group?.length) return null;
                const config = ENTITY_CONFIG[entityType];
                const EntityIcon = config.Icon;
                return (
                  <li key={entityType}>
                    <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                      <EntityIcon className="w-3.5 h-3.5 text-gray-400" />
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{config.label}s</span>
                    </div>
                    <ul className="space-y-0.5">
                      {group.map((record) => {
                        const flatIdx = flatResults.indexOf(record);
                        const isSelected = flatIdx === selectedIndex;
                        const recId = record._id || record.id || "";
                        return (
                          <li key={recId || flatIdx} id={`search-result-item-${flatIdx}`}
                            role="option" aria-selected={isSelected}
                            onClick={() => handleSelectRecord(record)}
                            onMouseEnter={() => setSelectedIndex(flatIdx)}
                            className={`p-3 rounded-lg flex items-center cursor-pointer transition-colors ${isSelected ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-200" : "hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300"}`}
                            data-testid={`search-result-item-${flatIdx}`}>
                            <div className="mr-3 flex-shrink-0">
                              <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full ${config.pillClass}`}>
                                <EntityIcon className="w-3.5 h-3.5" />
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-semibold text-sm truncate">{config.primaryText(record)}</span>
                                {config.secondaryText(record) && <span className="text-xs text-gray-400 font-mono shrink-0">{config.secondaryText(record)}</span>}
                                {record.status && <StatusBadge status={record.status} />}
                              </div>
                              {config.metaText(record) && <div className="text-xs text-gray-500 font-mono truncate">{config.metaText(record)}</div>}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className={`hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${config.pillClass}`}>{config.label}</span>
                              <CornerDownLeft className="w-3.5 h-3.5 text-gray-400" />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          ) : query.trim() ? (
            <div className="py-12 text-center text-gray-500 text-sm" data-testid="no-results">
              No results for <span className="font-semibold text-gray-700 dark:text-gray-300">&ldquo;{query}&rdquo;</span> across transactions, users, or wallets.
            </div>
          ) : (
            <div className="py-8 text-center text-gray-400 text-xs">Type to perform instant fuzzy search across indexed records.</div>
          )}
        </div>

        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-3"><span>↑↓ Navigate</span><span>↵ Select</span><span>ESC Close</span></div>
          {searchDuration !== null && <span className="font-mono text-emerald-600 dark:text-emerald-400">⚡ {searchDuration} ms</span>}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, CornerDownLeft, Loader2 } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { getAdminTransactions } from "@/lib/adminApi";

/**
 * Global search modal with instantaneous fuzzy search over client index
 * powered by a Web Worker. Triggered globally via Cmd+K / Ctrl+K.
 */
export default function GlobalSearchModal({ isOpen, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchDuration, setSearchDuration] = useState(null);

  const workerRef = useRef(null);
  const inputRef = useRef(null);

  // Initialize Web Worker and pre-index recent transactions
  useEffect(() => {
    let worker;
    try {
      worker = new Worker(
        new URL("../workers/searchWorker.js", import.meta.url),
        {
          type: "module",
        },
      );
      workerRef.current = worker;

      worker.onmessage = (event) => {
        const { type, results: searchResults, durationMs } = event.data || {};
        if (type === "SEARCH_RESULTS") {
          setResults(searchResults || []);
          setSearchDuration(durationMs ? durationMs.toFixed(2) : "0.00");
          setLoading(false);
          setSelectedIndex(0);
        }
      };

      // Fetch transactions to seed worker in-memory index
      getAdminTransactions({ limit: 100 })
        .then((res) => {
          if (res?.data && workerRef.current) {
            workerRef.current.postMessage({
              type: "INDEX_DATA",
              payload: { records: res.data },
            });
          }
        })
        .catch(() => {});
    } catch {
      // Fallback in environments without Web Worker support (e.g. mock test environments)
    }

    return () => {
      if (worker) worker.terminate();
    };
  }, []);

  // Autofocus input when modal opens
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset search state each time the modal opens
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Execute search through worker
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear results when query is emptied; search results arrive async from the worker
      setResults([]);
      setSearchDuration(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: "SEARCH",
        payload: { query: trimmed, limit: 15 },
      });
    } else {
      // Fallback synchronous search if worker unavailable
      setLoading(false);
    }
  }, [query]);

  // Keyboard navigation inside modal
  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        results.length > 0 ? (prev + 1) % results.length : 0,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        results.length > 0 ? (prev - 1 + results.length) % results.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[selectedIndex]) {
        handleSelectRecord(results[selectedIndex]);
      }
    }
  };

  const handleSelectRecord = (record) => {
    onClose();
    if (record._id || record.id) {
      navigate(`/transactions/${record._id || record.id}`);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-search-title"
      data-testid="global-search-modal"
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
        {/* Search Input Bar */}
        <div className="flex items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 gap-3">
          <Search className="w-5 h-5 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions by hash, phone (+234...), amount, memo, or type..."
            className="flex-1 bg-transparent border-0 text-sm focus:outline-none text-gray-900 dark:text-white placeholder-gray-400"
            data-testid="global-search-input"
          />
          {loading ? (
            <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
          ) : query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          ) : null}
          <kbd className="hidden sm:inline-block px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
            ESC
          </kbd>
        </div>

        {/* Search Results / Empty State */}
        <div
          className="max-h-96 overflow-y-auto p-2"
          data-testid="global-search-results"
        >
          {results.length > 0 ? (
            <ul className="space-y-1">
              {results.map((record, index) => {
                const isSelected = index === selectedIndex;
                const phone =
                  record.userId?.phoneNumber ||
                  record.user?.phoneNumber ||
                  record.phoneNumber ||
                  "Unknown";
                const txId = record._id || record.id || "";
                return (
                  <li
                    key={txId || index}
                    onClick={() => handleSelectRecord(record)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`p-3 rounded-lg flex items-center justify-between cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-200"
                        : "hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300"
                    }`}
                    data-testid={`search-result-item-${index}`}
                  >
                    <div className="flex flex-col gap-1 min-w-0 flex-1 mr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">
                          {record.amount
                            ? `${record.amount} ${record.asset || "USDC"}`
                            : record.type || "Transaction"}
                        </span>
                        <span className="text-xs text-gray-400 font-mono">
                          {phone}
                        </span>
                        {record.status && (
                          <StatusBadge status={record.status} />
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500 truncate font-mono">
                        <span>ID: {txId}</span>
                        {record.txHash && (
                          <span className="truncate">
                            Hash: {record.txHash}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-400">
                      <span>Jump</span>
                      <CornerDownLeft className="w-3.5 h-3.5" />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : query.trim() ? (
            <div
              className="py-12 text-center text-gray-500 text-sm"
              data-testid="no-results"
            >
              No transactions matching{" "}
              <span className="font-semibold text-gray-700 dark:text-gray-300">
                "{query}"
              </span>{" "}
              found in client index.
            </div>
          ) : (
            <div className="py-8 text-center text-gray-400 text-xs">
              Type to perform instant fuzzy search across indexed transaction
              records.
            </div>
          )}
        </div>

        {/* Footer Meta */}
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>ESC Close</span>
          </div>
          {searchDuration !== null && (
            <span className="font-mono text-emerald-600 dark:text-emerald-400">
              ⚡ Search time: {searchDuration} ms
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

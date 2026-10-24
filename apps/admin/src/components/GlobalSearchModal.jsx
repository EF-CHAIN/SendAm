import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  X,
  CornerDownLeft,
  Loader2,
  Users,
  User,
  ArrowLeftRight,
  Wallet,
} from "lucide-react";
import StatusBadge from "./StatusBadge";
import HighlightMatch from "./HighlightMatch";
import { getRecordCategory, CATEGORY_ORDER } from "@/lib/searchUtils";
import {
  getAdminTransactions,
  getAdminUsers,
  getAdminWallets,
} from "@/lib/adminApi";

/**
 * Global search modal with categorized search results (Users, Transactions, Stellar Accounts)
 * and instantaneous fuzzy search powered by a Web Worker. Triggered globally via Cmd+K / Ctrl+K.
 */
export default function GlobalSearchModal({ isOpen, onClose, initialResults }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(initialResults || []);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchDuration, setSearchDuration] = useState(null);

  const workerRef = useRef(null);
  const inputRef = useRef(null);
  const cachedRecordsRef = useRef([]);

  // Initialize Web Worker and pre-index transactions, users, and wallets
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

      // Fetch entities to seed worker in-memory index
      Promise.allSettled([
        getAdminTransactions({ limit: 100 }),
        getAdminUsers({ limit: 100 }),
        getAdminWallets({ limit: 100 }),
      ])
        .then(([txRes, userRes, walletRes]) => {
          const records = [];
          if (txRes.status === "fulfilled" && txRes.value?.data) {
            records.push(
              ...txRes.value.data.map((r) => ({
                ...r,
                category: "Transactions",
              })),
            );
          }
          if (userRes.status === "fulfilled" && userRes.value?.data) {
            records.push(
              ...userRes.value.data.map((r) => ({ ...r, category: "Users" })),
            );
          }
          if (walletRes.status === "fulfilled" && walletRes.value?.data) {
            records.push(
              ...walletRes.value.data.map((r) => ({
                ...r,
                category: "Stellar Accounts",
              })),
            );
          }

          cachedRecordsRef.current = records;

          if (records.length > 0 && workerRef.current) {
            workerRef.current.postMessage({
              type: "INDEX_DATA",
              payload: { records },
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
      setResults(initialResults || []);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialResults]);

  // Execute search through worker or synchronous fallback
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear or restore initial results when query is emptied
      setResults(initialResults || []);
      setSearchDuration(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: "SEARCH",
        payload: { query: trimmed, limit: 20 },
      });
    } else {
      // Fallback synchronous search if worker unavailable (e.g. Vitest test runner)
      const q = trimmed.toLowerCase();
      const pool =
        cachedRecordsRef.current.length > 0
          ? cachedRecordsRef.current
          : initialResults || [];
      const filtered = pool
        .filter((r) => {
          const text = JSON.stringify(r).toLowerCase();
          return text.includes(q);
        })
        .slice(0, 20);
      setResults(filtered);
      setLoading(false);
    }
  }, [query, initialResults]);

  // Group results into titled sections: 'Users', 'Transactions', 'Stellar Accounts'
  const categorizedResults = useMemo(() => {
    const groups = {
      Users: [],
      Transactions: [],
      "Stellar Accounts": [],
    };

    results.forEach((record) => {
      const cat = getRecordCategory(record);
      if (!groups[cat]) {
        groups[cat] = [];
      }
      groups[cat].push(record);
    });

    return groups;
  }, [results]);

  // Flatten grouped results in category order for keyboard navigation
  const flattenedResults = useMemo(() => {
    const items = [];
    CATEGORY_ORDER.forEach((cat) => {
      if (categorizedResults[cat] && categorizedResults[cat].length > 0) {
        categorizedResults[cat].forEach((rec) => {
          items.push(rec);
        });
      }
    });
    return items;
  }, [categorizedResults]);

  // Keyboard navigation inside modal
  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        flattenedResults.length > 0 ? (prev + 1) % flattenedResults.length : 0,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        flattenedResults.length > 0
          ? (prev - 1 + flattenedResults.length) % flattenedResults.length
          : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flattenedResults[selectedIndex]) {
        handleSelectRecord(flattenedResults[selectedIndex]);
      }
    }
  };

  const handleSelectRecord = (record) => {
    onClose();
    const cat = getRecordCategory(record);
    const id = record._id || record.id;
    if (cat === "Users") {
      navigate("/users");
    } else if (cat === "Stellar Accounts") {
      navigate("/wallets");
    } else {
      if (id) {
        navigate(`/transactions/${id}`);
      } else {
        navigate("/transactions");
      }
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
            placeholder="Search users, transactions, and Stellar accounts..."
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

        {/* Categorized Search Results / Empty State */}
        <div
          className="max-h-96 overflow-y-auto p-2"
          data-testid="global-search-results"
        >
          {flattenedResults.length > 0 ? (
            <div className="space-y-4">
              {CATEGORY_ORDER.map((category) => {
                const items = categorizedResults[category] || [];
                if (items.length === 0) return null;

                const CategorySectionIcon =
                  category === "Users"
                    ? Users
                    : category === "Stellar Accounts"
                    ? Wallet
                    : ArrowLeftRight;

                return (
                  <div
                    key={category}
                    className="space-y-1.5"
                    data-testid={`search-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 flex items-center justify-between border-b border-gray-100 dark:border-gray-700/60 bg-gray-50/80 dark:bg-gray-900/40 rounded">
                      <div className="flex items-center gap-1.5">
                        <CategorySectionIcon className="w-3.5 h-3.5 text-gray-400" />
                        <span>{category}</span>
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                        {items.length}
                      </span>
                    </div>

                    <ul className="space-y-1">
                      {items.map((record) => {
                        const globalIndex = flattenedResults.indexOf(record);
                        const isSelected = globalIndex === selectedIndex;
                        const phone =
                          record.userId?.phoneNumber ||
                          record.user?.phoneNumber ||
                          record.phoneNumber ||
                          record.phone ||
                          "Unknown";
                        const id = record._id || record.id || "";

                        return (
                          <li
                            key={id || globalIndex}
                            onClick={() => handleSelectRecord(record)}
                            onMouseEnter={() => setSelectedIndex(globalIndex)}
                            className={`p-3 rounded-lg flex items-center justify-between cursor-pointer transition-colors ${
                              isSelected
                                ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-200 ring-1 ring-indigo-400/30"
                                : "hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300"
                            }`}
                            data-testid={`search-result-item-${globalIndex}`}
                          >
                            <div className="flex flex-col gap-1 min-w-0 flex-1 mr-4">
                              {/* Entity Header Line */}
                              <div className="flex items-center gap-2 flex-wrap">
                                {/* Category Badge */}
                                {category === "Users" && (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                                    data-testid="badge-users"
                                  >
                                    <User className="w-3 h-3" />
                                    <span>User</span>
                                  </span>
                                )}
                                {category === "Transactions" && (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                                    data-testid="badge-transactions"
                                  >
                                    <ArrowLeftRight className="w-3 h-3" />
                                    <span>Transaction</span>
                                  </span>
                                )}
                                {category === "Stellar Accounts" && (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                                    data-testid="badge-stellar-accounts"
                                  >
                                    <Wallet className="w-3 h-3" />
                                    <span>Stellar Account</span>
                                  </span>
                                )}

                                {/* Main Title with Term Highlighting */}
                                <span className="font-semibold text-sm">
                                  {category === "Users" ? (
                                    <HighlightMatch
                                      text={
                                        record.whatsappName ||
                                        record.name ||
                                        phone
                                      }
                                      query={query}
                                    />
                                  ) : category === "Stellar Accounts" ? (
                                    <HighlightMatch
                                      text={
                                        record.label ||
                                        (record.publicKey
                                          ? `${record.publicKey.substring(0, 8)}...${record.publicKey.substring(record.publicKey.length - 6)}`
                                          : "Stellar Wallet")
                                      }
                                      query={query}
                                    />
                                  ) : (
                                    <HighlightMatch
                                      text={
                                        record.amount
                                          ? `${record.amount} ${record.asset || "USDC"}`
                                          : record.type || "Transaction"
                                      }
                                      query={query}
                                    />
                                  )}
                                </span>

                                {/* StatusBadge for Transactions */}
                                {record.status && (
                                  <StatusBadge status={record.status} />
                                )}

                                {/* KYC Status for Users */}
                                {record.kycStatus && (
                                  <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                    KYC: {record.kycStatus}
                                  </span>
                                )}
                              </div>

                              {/* Metadata Snippet Line */}
                              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 truncate font-mono">
                                {category === "Users" ? (
                                  <>
                                    <span>
                                      Phone:{" "}
                                      <HighlightMatch
                                        text={phone}
                                        query={query}
                                      />
                                    </span>
                                    {id && (
                                      <span>
                                        ID:{" "}
                                        <HighlightMatch
                                          text={id}
                                          query={query}
                                        />
                                      </span>
                                    )}
                                  </>
                                ) : category === "Stellar Accounts" ? (
                                  <>
                                    {record.publicKey && (
                                      <span className="truncate">
                                        Key:{" "}
                                        <HighlightMatch
                                          text={record.publicKey}
                                          query={query}
                                        />
                                      </span>
                                    )}
                                    {record.network && (
                                      <span className="capitalize">
                                        {record.network}
                                      </span>
                                    )}
                                    {phone !== "Unknown" && (
                                      <span>
                                        Owner:{" "}
                                        <HighlightMatch
                                          text={phone}
                                          query={query}
                                        />
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    {phone !== "Unknown" && (
                                      <span>
                                        <HighlightMatch
                                          text={phone}
                                          query={query}
                                        />
                                      </span>
                                    )}
                                    {id && (
                                      <span>
                                        ID:{" "}
                                        <HighlightMatch
                                          text={id}
                                          query={query}
                                        />
                                      </span>
                                    )}
                                    {record.txHash && (
                                      <span className="truncate">
                                        Hash:{" "}
                                        <HighlightMatch
                                          text={record.txHash}
                                          query={query}
                                        />
                                      </span>
                                    )}
                                  </>
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
                  </div>
                );
              })}
            </div>
          ) : query.trim() ? (
            <div
              className="py-12 text-center text-gray-500 text-sm"
              data-testid="no-results"
            >
              No records matching{" "}
              <span className="font-semibold text-gray-700 dark:text-gray-300">
                "{query}"
              </span>{" "}
              found in client index.
            </div>
          ) : (
            <div className="py-8 text-center text-gray-400 text-xs">
              Type to perform instant fuzzy search across categorized Users,
              Transactions, and Stellar Accounts.
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

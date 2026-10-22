/**
 * Dedicated Web Worker for background in-memory inverted index and fuzzy search.
 * Covers transactions, users, and wallets (multi-entity omnibox — Issue #757).
 * Computes Levenshtein distance, token prefix match scoring, and multi-field matching
 * without blocking or freezing the main UI thread.
 */

// In-memory store: all indexed records across entity types
let records = [];
let indexedRecords = [];

/**
 * Computes Levenshtein edit distance between two strings.
 */
function levenshteinDistance(s1, s2) {
  if (s1 === s2) return 0;
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;

  const row = [];
  for (let i = 0; i <= s2.length; i++) {
    row[i] = i;
  }

  for (let i = 1; i <= s1.length; i++) {
    let prev = i;
    for (let j = 1; j <= s2.length; j++) {
      let val;
      if (s1[i - 1] === s2[j - 1]) {
        val = row[j - 1];
      } else {
        val = Math.min(row[j - 1] + 1, Math.min(prev + 1, row[j] + 1));
      }
      row[j - 1] = prev;
      prev = val;
    }
    row[s2.length] = prev;
  }

  return row[s2.length];
}

/**
 * Tokenizes text into searchable words and normalized strings.
 */
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s+@.-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Builds a searchable text representation for a transaction record.
 */
function indexTransaction(record) {
 * Resolves the display entity category for search records.
 */
function getRecordCategory(record) {
  if (record.category) {
    const cat = String(record.category).toLowerCase();
    if (cat.includes("user")) return "Users";
    if (cat.includes("account") || cat.includes("wallet")) return "Stellar Accounts";
    return "Transactions";
  }
  if (record.publicKey) return "Stellar Accounts";
  if (record.whatsappName || (record.role && !record.txHash)) return "Users";
  return "Transactions";
}

/**
 * Builds searchable representation of transaction/user/wallet record.
 */
function indexRecord(record) {
  const category = getRecordCategory(record);
  const searchableParts = [
    record.id || record._id || "",
    record.txHash || record.hash || "",
    record.publicKey || "",
    record.phoneNumber || record.phone || record.userId?.phoneNumber || "",
    record.user?.phoneNumber || record.user?.whatsappName || record.whatsappName || "",
    record.name || record.email || "",
    record.label || "",
    record.amount != null ? String(record.amount) : "",
    record.asset || "",
    record.type || "",
    record.status || "",
    record.rail || "",
    record.destination || "",
    record.memo || "",
    category,
  ];
  return searchableParts.join(" ").toLowerCase();
}

/**
 * Builds a searchable text representation for a user record.
 */
function indexUser(record) {
  const searchableParts = [
    record.id || record._id || "",
    record.email || "",
    record.phoneNumber || record.phone || "",
    record.firstName || "",
    record.lastName || "",
    record.whatsappName || record.displayName || "",
    record.kycStatus || record.status || "",
    record.country || "",
    record.tier || "",
  ];
  return searchableParts.join(" ").toLowerCase();
}

/**
 * Builds a searchable text representation for a wallet record.
 */
function indexWallet(record) {
  const searchableParts = [
    record.id || record._id || "",
    record.address || record.walletAddress || "",
    record.network || record.chain || "",
    record.asset || record.currency || "",
    record.label || record.name || "",
    record.status || "",
    record.userId || record.owner || "",
    record.balance != null ? String(record.balance) : "",
  ];
  return searchableParts.join(" ").toLowerCase();
}

/**
 * Builds searchable representation of a record based on its entityType.
 */
function indexRecord(record) {
  let fullText;
  const entityType = record._entityType;

  if (entityType === "user") {
    fullText = indexUser(record);
  } else if (entityType === "wallet") {
    fullText = indexWallet(record);
  } else {
    fullText = indexTransaction(record);
  }

  const tokens = Array.from(new Set(tokenize(fullText)));

  return {
    raw: { ...record, category: record.category || category },
    category,
    fullText,
    tokens,
  };
}

/**
 * Scores a record against query tokens. Higher score = better match.
 */
function scoreRecord(indexed, queryTokens, rawQuery) {
  let score = 0;
  const fullText = indexed.fullText;

  // Exact substring match bonus
  if (fullText.includes(rawQuery)) {
    score += 100;
  }

  for (const qToken of queryTokens) {
    let tokenMatched = false;

    // Check exact token or prefix
    for (const recordToken of indexed.tokens) {
      if (recordToken === qToken) {
        score += 50;
        tokenMatched = true;
        break;
      } else if (recordToken.startsWith(qToken)) {
        score += 30;
        tokenMatched = true;
        break;
      } else if (qToken.length >= 3) {
        // Fuzzy Levenshtein match for longer words
        const distance = levenshteinDistance(qToken, recordToken);
        const maxAllowed = qToken.length > 5 ? 2 : 1;
        if (distance <= maxAllowed) {
          score += 20 - distance * 5;
          tokenMatched = true;
          break;
        }
      }
    }

    if (!tokenMatched && fullText.includes(qToken)) {
      score += 10;
    }
  }

  return score;
}

/**
 * Performs fuzzy search over indexed records.
 */
function search(query, limit = 20) {
  if (!query || typeof query !== "string") {
    return [];
  }

  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return [];

  const queryTokens = tokenize(cleanQuery);
  const results = [];

  for (const item of indexedRecords) {
    const score = scoreRecord(item, queryTokens, cleanQuery);
    if (score > 0) {
      results.push({
        record: item.raw,
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => r.record);
}

// Worker message handling
self.onmessage = function (event) {
  const { type, payload, id } = event.data || {};

  switch (type) {
    /**
     * INDEX_MULTI: indexes transactions, users, and wallets in a single pass.
     * Each record is tagged with _entityType before being passed to indexRecord().
     * payload = { transactions: [], users: [], wallets: [] }
     */
    case "INDEX_MULTI": {
      const transactions = (payload?.transactions || []).map((r) => ({
        ...r,
        _entityType: "transaction",
      }));
      const users = (payload?.users || []).map((r) => ({
        ...r,
        _entityType: "user",
      }));
      const wallets = (payload?.wallets || []).map((r) => ({
        ...r,
        _entityType: "wallet",
      }));

      records = [...transactions, ...users, ...wallets];
      indexedRecords = records.map(indexRecord);

      self.postMessage({
        type: "INDEX_COMPLETE",
        id,
        count: indexedRecords.length,
        breakdown: {
          transactions: transactions.length,
          users: users.length,
          wallets: wallets.length,
        },
      });
      break;
    }

    /**
     * INDEX_DATA: legacy single-entity index for backward compatibility.
     * Records are treated as transactions unless they carry _entityType.
     */
    case "INDEX_DATA": {
      records = (payload?.records || []).map((r) => ({
        _entityType: "transaction",
        ...r,
      }));
      indexedRecords = records.map(indexRecord);
      self.postMessage({
        type: "INDEX_COMPLETE",
        id,
        count: indexedRecords.length,
      });
      break;
    }

    case "SEARCH": {
      const startTime = performance.now();
      const results = search(payload?.query, payload?.limit || 20);
      const durationMs = performance.now() - startTime;

      self.postMessage({
        type: "SEARCH_RESULTS",
        id,
        query: payload?.query,
        results,
        durationMs,
      });
      break;
    }

    case "CLEAR": {
      records = [];
      indexedRecords = [];
      self.postMessage({
        type: "CLEARED",
        id,
      });
      break;
    }

    default:
      break;
  }
};

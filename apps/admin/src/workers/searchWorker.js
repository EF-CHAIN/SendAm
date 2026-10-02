/**
 * Dedicated Web Worker for background in-memory inverted index and fuzzy search.
 * Computes Levenshtein distance, token prefix match scoring, and multi-field matching
 * without blocking or freezing the main UI thread.
 */

// Inverted index maps token prefixes and keywords to record IDs
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
 * Builds searchable representation of transaction/user record.
 */
function indexRecord(record) {
  const searchableParts = [
    record.id || record._id || "",
    record.txHash || record.hash || "",
    record.phoneNumber || record.phone || record.userId?.phoneNumber || "",
    record.user?.phoneNumber || record.user?.whatsappName || "",
    record.amount != null ? String(record.amount) : "",
    record.asset || "",
    record.type || "",
    record.status || "",
    record.rail || "",
    record.destination || "",
    record.memo || "",
  ];

  const fullText = searchableParts.join(" ").toLowerCase();
  const tokens = Array.from(new Set(tokenize(fullText)));

  return {
    raw: record,
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
    case "INDEX_DATA": {
      records = payload?.records || [];
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

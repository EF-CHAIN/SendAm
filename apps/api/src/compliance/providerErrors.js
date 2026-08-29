// Shared error used by provider adapters to signal "not configured -> skip"
// rather than "failed". The privacy service records a skip as a visible,
// non-failing task state (distinct from a retryable failure).
class ProviderSkippedError extends Error {
  constructor(message = 'provider data deletion not configured; skipped') {
    super(message);
    this.name = 'ProviderSkippedError';
    this.skipped = true;
  }
}

module.exports = { ProviderSkippedError };

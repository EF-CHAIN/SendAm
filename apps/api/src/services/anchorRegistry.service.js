const axios = require('axios');
const logger = require('../utils/logger');

const ANCHOR_STATUS = Object.freeze({
  ACTIVE: 'active',
  DEGRADED: 'degraded',
  INACTIVE: 'inactive',
});

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_HEALTH_INTERVAL_MS = 60000;
const DEFAULT_FAILURE_THRESHOLD = 1;

const normalizeCorridor = (corridor) => String(corridor || '').trim().toUpperCase();

/**
 * Registry of approved Stellar anchors with periodic GET /info health checks
 * and corridor-aware failover routing.
 */
class AnchorRegistry {
  /**
   * @param {object} [options]
   * @param {object} [options.httpClient] - HTTP client with `.get(url, config)`
   * @param {number} [options.healthCheckTimeoutMs]
   * @param {number} [options.failureThreshold] - Consecutive failures before marking inactive
   */
  constructor({
    httpClient = axios,
    healthCheckTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  } = {}) {
    this.httpClient = httpClient;
    this.healthCheckTimeoutMs = healthCheckTimeoutMs;
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 1);
    this.anchors = new Map();
    this._timer = null;
  }

  /**
   * Registers an approved anchor in the directory.
   *
   * @param {object} anchor
   * @param {string} anchor.id
   * @param {string} anchor.baseUrl
   * @param {string} [anchor.name]
   * @param {string} [anchor.infoPath='/info']
   * @param {string[]} [anchor.corridors=[]]
   * @param {number} [anchor.priority=100]
   * @param {string} [anchor.rail='sep24']
   * @param {object} [anchor.capabilities={}]
   * @returns {object} Registered anchor record
   */
  registerAnchor(anchor) {
    if (!anchor || typeof anchor.id !== 'string' || !anchor.id.trim()) {
      throw new Error('Anchor registration requires a non-empty string id.');
    }
    if (typeof anchor.baseUrl !== 'string' || !anchor.baseUrl.trim()) {
      throw new Error(`Anchor "${anchor.id}" requires a non-empty baseUrl.`);
    }

    const id = anchor.id.trim();
    const record = {
      id,
      name: anchor.name || id,
      baseUrl: anchor.baseUrl.trim().replace(/\/+$/, ''),
      infoPath: anchor.infoPath ? `/${String(anchor.infoPath).replace(/^\/+/, '')}` : '/info',
      corridors: Array.isArray(anchor.corridors)
        ? [...new Set(anchor.corridors.map(normalizeCorridor).filter(Boolean))]
        : [],
      priority: Number.isFinite(Number(anchor.priority)) ? Number(anchor.priority) : 100,
      rail: anchor.rail || 'sep24',
      capabilities: { ...(anchor.capabilities || {}) },
      status: anchor.status || ANCHOR_STATUS.ACTIVE,
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastError: null,
      latencyMs: null,
      info: null,
    };

    this.anchors.set(id, record);
    return { ...record };
  }

  unregisterAnchor(id) {
    return this.anchors.delete(id);
  }

  getAnchor(id) {
    const record = this.anchors.get(id);
    return record ? { ...record } : null;
  }

  listAnchors({ status, corridor } = {}) {
    const targetCorridor = corridor ? normalizeCorridor(corridor) : null;
    const results = [];
    for (const record of this.anchors.values()) {
      if (status && record.status !== status) continue;
      if (targetCorridor && !record.corridors.includes(targetCorridor)) continue;
      results.push({ ...record });
    }
    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Executes a GET /info health check against a single registered anchor.
   *
   * @param {string} id
   * @returns {Promise<object>} Updated anchor record
   */
  async checkAnchorHealth(id) {
    const record = this.anchors.get(id);
    if (!record) {
      throw new Error(`Unknown anchor: ${id}`);
    }

    const url = `${record.baseUrl}${record.infoPath}`;
    const startedAt = Date.now();
    try {
      const response = await this.httpClient.get(url, {
        timeout: this.healthCheckTimeoutMs,
      });

      const statusCode = response && typeof response.status === 'number' ? response.status : 200;
      const data = response ? response.data : null;

      if (statusCode < 200 || statusCode >= 300 || !data || typeof data !== 'object') {
        throw new Error(`Unexpected health check response (${statusCode}) from ${url}`);
      }

      record.consecutiveFailures = 0;
      record.status = ANCHOR_STATUS.ACTIVE;
      record.lastCheckedAt = new Date().toISOString();
      record.lastError = null;
      record.latencyMs = Date.now() - startedAt;
      record.info = data;

      if (data.capabilities && typeof data.capabilities === 'object') {
        record.capabilities = { ...record.capabilities, ...data.capabilities };
      }

      return { ...record };
    } catch (err) {
      record.consecutiveFailures += 1;
      record.lastCheckedAt = new Date().toISOString();
      record.lastError = err && err.message ? err.message : String(err);
      record.latencyMs = Date.now() - startedAt;
      record.status = record.consecutiveFailures >= this.failureThreshold
        ? ANCHOR_STATUS.INACTIVE
        : ANCHOR_STATUS.DEGRADED;

      logger.warn('anchor_health_check_failed', {
        anchorId: record.id,
        url,
        status: record.status,
        consecutiveFailures: record.consecutiveFailures,
        error: record.lastError,
      });

      return { ...record };
    }
  }

  /**
   * Checks all registered anchors concurrently.
   *
   * @returns {Promise<object[]>}
   */
  async checkAllAnchors() {
    const ids = [...this.anchors.keys()];
    return Promise.all(ids.map((id) => this.checkAnchorHealth(id)));
  }

  /**
   * Starts periodic health checks.
   *
   * @param {number} [intervalMs=60000]
   */
  startHealthChecks(intervalMs = DEFAULT_HEALTH_INTERVAL_MS) {
    this.stopHealthChecks();
    const interval = Math.max(100, Number(intervalMs) || DEFAULT_HEALTH_INTERVAL_MS);
    this._timer = setInterval(() => {
      this.checkAllAnchors().catch((err) => {
        logger.error('anchor_health_check_loop_error', err);
      });
    }, interval);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  stopHealthChecks() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Resolves the best active anchor for a corridor, falling back to a secondary
   * rail or returning an explicit unavailability notice when all anchors are degraded/inactive.
   *
   * @param {string} corridor - Corridor identifier (e.g. 'NGN:USDC', 'USD:NGN')
   * @param {object} [options]
   * @param {string|null} [options.fallbackRail='stellar']
   * @returns {object}
   */
  resolveCorridor(corridor, { fallbackRail = 'stellar' } = {}) {
    const normalized = normalizeCorridor(corridor);
    const activeAnchors = this.listAnchors({ status: ANCHOR_STATUS.ACTIVE, corridor: normalized });

    if (activeAnchors.length > 0) {
      const [primary, ...alternatives] = activeAnchors;
      return {
        available: true,
        corridor: normalized,
        anchor: primary,
        alternatives,
        rail: primary.rail,
        fallbackUsed: false,
        reason: null,
        message: null,
      };
    }

    const allForCorridor = this.listAnchors({ corridor: normalized });
    const reason = allForCorridor.length > 0 ? 'primary_anchors_inactive' : 'no_anchors_registered';

    if (fallbackRail) {
      return {
        available: true,
        corridor: normalized,
        anchor: null,
        alternatives: [],
        rail: fallbackRail,
        fallbackUsed: true,
        reason,
        message: `Primary anchor(s) for corridor ${normalized} are unavailable; falling back to ${fallbackRail} rail.`,
      };
    }

    return {
      available: false,
      corridor: normalized,
      anchor: null,
      alternatives: [],
      rail: null,
      fallbackUsed: false,
      reason,
      message: `Corridor ${normalized} is currently unavailable because all partner anchors are inactive.`,
    };
  }

  /**
   * Convenience selector for payment orchestrator corridor routing.
   *
   * @param {object} params
   * @param {string} params.sourceAsset
   * @param {string} params.destinationAsset
   * @param {string|null} [params.fallbackRail='stellar']
   * @returns {object}
   */
  selectAnchorForPayment({ sourceAsset, destinationAsset, fallbackRail = 'stellar' }) {
    const corridor = `${normalizeCorridor(sourceAsset)}:${normalizeCorridor(destinationAsset)}`;
    return this.resolveCorridor(corridor, { fallbackRail });
  }
}

const defaultRegistry = new AnchorRegistry();

module.exports = {
  ANCHOR_STATUS,
  AnchorRegistry,
  anchorRegistry: defaultRegistry,
};

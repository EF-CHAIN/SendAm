'use strict';

/**
 * Resource sampling: database connections and process memory.
 *
 * Latency and throughput describe what callers experienced; these describe how
 * close the service came to a hard limit while delivering it. A run can sit
 * comfortably inside its latency budget while consuming 95% of the connection
 * pool, and that run is one traffic step away from failing — the HTTP metrics
 * alone would not show it.
 *
 * Sampling runs *during* the load, on an interval, and reports peaks. Sampling
 * once at the end would consistently miss them: pools drain and garbage is
 * collected the moment pressure comes off.
 */

const DEFAULT_INTERVAL_MS = 500;

/** Pulls `sendam_process_resident_memory_bytes` out of the Prometheus text format. */
const parseResidentMemory = (text) => {
  for (const line of text.split('\n')) {
    if (line.startsWith('sendam_process_resident_memory_bytes ')) {
      const value = Number(line.split(' ')[1]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
};

class ResourceSampler {
  /**
   * @param {object} options
   * @param {URL}    [options.metricsUrl]  target's /metrics endpoint
   * @param {string} [options.metricsToken] bearer token for /metrics
   * @param {string} [options.databaseUrl]  connection string for pg_stat_activity
   * @param {number} [options.intervalMs]
   */
  constructor({ metricsUrl, metricsToken, databaseUrl, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.metricsUrl = metricsUrl;
    this.metricsToken = metricsToken;
    this.databaseUrl = databaseUrl;
    this.intervalMs = intervalMs;

    this.timer = null;
    this.client = null;
    this.samples = { memoryBytes: [], connections: [] };
    this.maxConnections = null;
    this.errors = new Set();
  }

  get canSampleMemory() {
    return Boolean(this.metricsUrl && this.metricsToken);
  }

  get canSampleConnections() {
    return Boolean(this.databaseUrl);
  }

  async start() {
    if (this.canSampleConnections) {
      try {
        const { Client } = require('pg');
        this.client = new Client({ connectionString: this.databaseUrl });
        await this.client.connect();
        const { rows } = await this.client.query('SHOW max_connections');
        this.maxConnections = Number(rows[0].max_connections);
      } catch (error) {
        this.errors.add(`connections: ${error.message}`);
        this.client = null;
      }
    }

    // An immediate sample means even a very short run records something.
    await this.sampleOnce();
    this.timer = setInterval(() => { this.sampleOnce().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }

  async sampleOnce() {
    await Promise.all([this.sampleMemory(), this.sampleConnections()]);
  }

  async sampleMemory() {
    if (!this.canSampleMemory) return;
    try {
      const response = await fetch(this.metricsUrl, {
        headers: { authorization: `Bearer ${this.metricsToken}` },
      });
      if (!response.ok) {
        this.errors.add(`memory: /metrics returned ${response.status}`);
        return;
      }
      const value = parseResidentMemory(await response.text());
      if (value !== null) this.samples.memoryBytes.push(value);
    } catch (error) {
      this.errors.add(`memory: ${error.message}`);
    }
  }

  async sampleConnections() {
    if (!this.client) return;
    try {
      // Counted per-database rather than cluster-wide so a shared Postgres
      // does not attribute someone else's connections to this run.
      const { rows } = await this.client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE state = 'active')::int AS active,
                count(*) FILTER (WHERE state = 'idle')::int AS idle
           FROM pg_stat_activity
          WHERE datname = current_database()`,
      );
      this.samples.connections.push(rows[0]);
    } catch (error) {
      this.errors.add(`connections: ${error.message}`);
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }

  /**
   * @returns {{memory: object, connections: object}} each either measured or
   *          carrying the reason it was not, never a silent zero.
   */
  report() {
    const memoryValues = this.samples.memoryBytes;
    const connectionSamples = this.samples.connections;

    const memory = memoryValues.length > 0
      ? {
        measured: true,
        peakBytes: Math.max(...memoryValues),
        peakMb: Math.round(Math.max(...memoryValues) / 1024 / 1024),
        samples: memoryValues.length,
      }
      : {
        measured: false,
        reason: this.canSampleMemory
          ? [...this.errors].find((e) => e.startsWith('memory')) || 'no samples collected'
          : 'LOAD_METRICS_TOKEN not set; process memory not observed',
      };

    const connections = connectionSamples.length > 0
      ? {
        measured: true,
        peakTotal: Math.max(...connectionSamples.map((s) => s.total)),
        peakActive: Math.max(...connectionSamples.map((s) => s.active)),
        maxConnections: this.maxConnections,
        utilisation: this.maxConnections
          ? Math.round((Math.max(...connectionSamples.map((s) => s.total)) / this.maxConnections) * 100) / 100
          : null,
        samples: connectionSamples.length,
      }
      : {
        measured: false,
        reason: this.canSampleConnections
          ? [...this.errors].find((e) => e.startsWith('connections')) || 'no samples collected'
          : 'DATABASE_URL not set; database connections not observed',
      };

    return { memory, connections };
  }
}

module.exports = { ResourceSampler, parseResidentMemory, DEFAULT_INTERVAL_MS };

const crypto = require('node:crypto');

const counters = new Map();
const durations = new Map();
const gauges = new Map();
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const labelsKey = (labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
const labelsText = (labels) => {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
};

const increment = (name, labels = {}, value = 1) => {
  const key = `${name}:${labelsKey(labels)}`;
  const current = counters.get(key) || { name, labels, value: 0 };
  current.value += value;
  counters.set(key, current);
};

const observeDuration = (name, labels, seconds) => {
  const key = `${name}:${labelsKey(labels)}`;
  const current = durations.get(key) || { name, labels, count: 0, sum: 0, buckets: new Map() };
  current.count += 1;
  current.sum += seconds;
  for (const bucket of BUCKETS) {
    if (seconds <= bucket) current.buckets.set(bucket, (current.buckets.get(bucket) || 0) + 1);
  }
  durations.set(key, current);
};

const setGauge = (name, value, labels = {}) => {
  gauges.set(`${name}:${labelsKey(labels)}`, { name, labels, value });
};

const renderMetrics = () => {
  const lines = [
    '# HELP sendam_process_uptime_seconds Process uptime.',
    '# TYPE sendam_process_uptime_seconds gauge',
    `sendam_process_uptime_seconds ${process.uptime()}`,
    '# HELP sendam_process_resident_memory_bytes Resident memory.',
    '# TYPE sendam_process_resident_memory_bytes gauge',
    `sendam_process_resident_memory_bytes ${process.memoryUsage().rss}`,
  ];
  const names = new Set();
  for (const metric of counters.values()) {
    if (!names.has(metric.name)) {
      lines.push(`# TYPE ${metric.name} counter`);
      names.add(metric.name);
    }
    lines.push(`${metric.name}${labelsText(metric.labels)} ${metric.value}`);
  }
  for (const metric of durations.values()) {
    if (!names.has(metric.name)) {
      lines.push(`# TYPE ${metric.name} histogram`);
      names.add(metric.name);
    }
    for (const bucket of BUCKETS) {
      lines.push(`${metric.name}_bucket${labelsText({ ...metric.labels, le: bucket })} ${metric.buckets.get(bucket) || 0}`);
    }
    lines.push(`${metric.name}_bucket${labelsText({ ...metric.labels, le: '+Inf' })} ${metric.count}`);
    lines.push(`${metric.name}_sum${labelsText(metric.labels)} ${metric.sum}`);
    lines.push(`${metric.name}_count${labelsText(metric.labels)} ${metric.count}`);
  }
  for (const metric of gauges.values()) {
    if (!names.has(metric.name)) {
      lines.push(`# TYPE ${metric.name} gauge`);
      names.add(metric.name);
    }
    lines.push(`${metric.name}${labelsText(metric.labels)} ${metric.value}`);
  }
  return `${lines.join('\n')}\n`;
};

const secureEqual = (received, expected) => {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const metricsHandler = (req, res) => {
  const expected = process.env.METRICS_TOKEN;
  const received = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secureEqual(received, expected)) return res.sendStatus(403);
  res.type('text/plain; version=0.0.4').send(renderMetrics());
};

const requestMetrics = (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path || 'unmatched';
    const labels = { method: req.method, route, status_code: res.statusCode };
    increment('sendam_http_requests_total', labels);
    observeDuration('sendam_http_request_duration_seconds', labels, Number(process.hrtime.bigint() - started) / 1e9);
  });
  next();
};

const resetMetrics = () => {
  counters.clear();
  durations.clear();
  gauges.clear();
};

module.exports = {
  increment,
  observeDuration,
  setGauge,
  renderMetrics,
  metricsHandler,
  requestMetrics,
  resetMetrics,
};

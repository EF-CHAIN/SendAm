const crypto = require('node:crypto');

const METHOD_LABELS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const STATUS_LABELS = new Set(['200', '201', '202', '204', '206', '400', '401', '403', '404', '409', '422', '429', '500', '502', '503', '504']);

const metricsStore = {
  entries: [],
  record({ method, route, status }) {
    this.entries.push({
      method: normalizeMethodLabel(method),
      route: route && route !== '/' ? route : 'unmatched',
      status: normalizeStatusLabel(status),
    });
  },
  reset() {
    this.entries = [];
  },
};

const normalizeMethodLabel = (method) => {
  const value = String(method || 'UNKNOWN').trim().toUpperCase();
  return METHOD_LABELS.has(value) ? value : 'OTHER';
};

const normalizeStatusLabel = (status) => {
  const value = String(status ?? '0').trim();
  if (STATUS_LABELS.has(value)) return value;
  return 'OTHER';
};

const joinRoute = (base, route) => {
  if (!route) return base || '/';
  if (!base) return route;
  if (route === '/') return base;
  if (base.endsWith('/') && route.startsWith('/')) return `${base}${route.slice(1)}`;
  return `${base}${route}`;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const routeMatchesPath = (pattern, pathname) => {
  if (!pattern || !pathname) return false;
  const regexSource = pattern
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';
      return escapeRegExp(segment);
    })
    .join('/');

  const regex = new RegExp(`^/${regexSource}$`);
  return regex.test(pathname);
};

const findMatchedRouteTemplate = (req) => {
  if (!req || typeof req !== 'object') return 'unmatched';

  const pathname = req.originalUrl ? req.originalUrl.split('?')[0] : req.path || '/';
  const method = (req.method || 'GET').toLowerCase();
  const routerStack = req.app?._router?.stack || [];

  const walk = (stack, base = '') => {
    for (const layer of stack || []) {
      if (!layer) continue;

      if (layer.route && layer.route.methods && layer.route.methods[method]) {
        const routePaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const routePath of routePaths) {
          const candidate = joinRoute(base, routePath);
          if (routeMatchesPath(candidate, pathname)) {
            return candidate;
          }
        }
      }

      if (layer.handle && Array.isArray(layer.handle.stack)) {
        const nextBase = joinRoute(base, layer.path || '');
        const nested = walk(layer.handle.stack, nextBase);
        if (nested) return nested;
      }
    }

    return null;
  };

  return walk(routerStack) || 'unmatched';
};

const normalizeRouteLabel = (req) => {
  if (!req || typeof req !== 'object') return 'unmatched';

  if (req.route?.path) {
    const candidate = joinRoute(req.baseUrl || '', req.route.path);
    return candidate === '/' ? '/' : candidate;
  }

  const route = findMatchedRouteTemplate(req);
  return route === '/' ? '/' : route;
};

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
    const value = typeof metric.value === 'function' ? metric.value() : metric.value;
    lines.push(`${metric.name}${labelsText(metric.labels)} ${Number(value)}`);
  }
  return `${lines.join('\n')}\n`;
};

const secureEqual = (received, expected) => {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const isMetricsAuthorized = (authorization) => {
  const received = (authorization || '').replace(/^Bearer\s+/i, '');
  return secureEqual(received, process.env.METRICS_TOKEN);
};

const metricsHandler = (req, res) => {
  if (!isMetricsAuthorized(req.get('authorization'))) return res.sendStatus(403);
  res.type('text/plain; version=0.0.4').send(renderMetrics());
};

const requestMetrics = (req, res, next) => {
  const started = process.hrtime.bigint();
  const capture = () => {
    if (res.__metricRecorded) return;
    res.__metricRecorded = true;

    const route = normalizeRouteLabel(req);
    metricsStore.record({
      method: req.method,
      route,
      status: res.statusCode,
    });

    const labels = { method: req.method, route, status_code: res.statusCode };
    increment('sendam_http_requests_total', labels);
    observeDuration('sendam_http_request_duration_seconds', labels, Number(process.hrtime.bigint() - started) / 1e9);
  };

  res.once('finish', capture);
  res.once('close', capture);
  next();
};

const resetMetrics = () => {
  metricsStore.reset();
  counters.clear();
  durations.clear();
  gauges.clear();
};

const getMetricSnapshot = () => metricsStore.entries.slice();

module.exports = {
  METHOD_LABELS,
  STATUS_LABELS,
  metricsStore,
  normalizeMethodLabel,
  normalizeRouteLabel,
  normalizeStatusLabel,
  requestMetrics,
  getMetricSnapshot,
  increment,
  observeDuration,
  setGauge,
  renderMetrics,
  metricsHandler,
  resetMetrics,
  isMetricsAuthorized,
};

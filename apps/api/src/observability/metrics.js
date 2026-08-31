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

const requestMetrics = (req, res, next) => {
  const capture = () => {
    if (res.__metricRecorded) return;
    res.__metricRecorded = true;

    metricsStore.record({
      method: req.method,
      route: normalizeRouteLabel(req),
      status: res.statusCode,
    });
  };

  res.once('finish', capture);
  res.once('close', capture);
  next();
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
};

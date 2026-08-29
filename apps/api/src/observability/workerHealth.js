const http = require('node:http');
const os = require('node:os');
const { renderMetrics, setGauge, isMetricsAuthorized } = require('./metrics');

const createWorkerHealth = ({
  checkDatabase,
  checkRedis,
  getProcessors,
  expectedProcessors,
  heartbeatFreshnessMs,
  workerId = process.env.WORKER_INSTANCE_ID || `${process.env.HOSTNAME || os.hostname()}:${process.pid}`,
  now = Date.now,
}) => {
  let lastHeartbeatAt = now();
  let shuttingDown = false;
  let ready = false;
  const labels = { worker_id: workerId };

  setGauge('sendam_worker_info', 1, labels);
  setGauge('sendam_worker_ready', () => (ready ? 1 : 0), labels);
  setGauge('sendam_worker_last_heartbeat_timestamp_seconds', () => lastHeartbeatAt / 1000, labels);
  setGauge('sendam_worker_heartbeat_age_seconds', () => Math.max(0, (now() - lastHeartbeatAt) / 1000), labels);

  const check = async () => {
    const [database, redis] = await Promise.all([
      Promise.resolve().then(checkDatabase).then(() => true, () => false),
      Promise.resolve().then(checkRedis).then((result) => result?.ok === true, () => false),
    ]);
    const registered = getProcessors();
    const processors = expectedProcessors.every((name) => registered.includes(name));
    const heartbeatAgeMs = Math.max(0, now() - lastHeartbeatAt);
    const heartbeat = heartbeatAgeMs <= heartbeatFreshnessMs;
    ready = !shuttingDown && database && redis && processors && heartbeat;
    return {
      status: ready ? 'ready' : 'not_ready',
      workerId,
      checks: { database, redis, processors, heartbeat },
      registeredProcessors: registered,
      heartbeatAgeMs,
    };
  };

  return {
    workerId,
    beat: () => { lastHeartbeatAt = now(); },
    markShuttingDown: () => { shuttingDown = true; ready = false; },
    check,
  };
};

const startWorkerHealthServer = async ({ health, collectMetrics, port, metricsIntervalMs }) => {
  const refresh = async () => {
    await Promise.all([health.check(), collectMetrics()]);
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/live') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ status: 'alive' }));
      }
      if (req.method === 'GET' && req.url === '/ready') {
        const result = await health.check();
        res.writeHead(result.status === 'ready' ? 200 : 503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (req.method === 'GET' && req.url === '/metrics') {
        if (!isMetricsAuthorized(req.headers.authorization)) {
          res.writeHead(403);
          return res.end();
        }
        await refresh();
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return res.end(renderMetrics());
      }
      res.writeHead(404);
      return res.end();
    } catch (_error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'not_ready' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const metricsTimer = setInterval(() => refresh().catch(() => {}), metricsIntervalMs);
  metricsTimer.unref();

  return {
    close: async () => {
      clearInterval(metricsTimer);
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    server,
  };
};

module.exports = { createWorkerHealth, startWorkerHealthServer };

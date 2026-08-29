const logger = require('../utils/logger');
const { getContext } = require('./context');
const { increment } = require('./metrics');

let initialized = false;

const captureException = async (error, extra = {}) => {
  const context = { ...getContext(), ...extra };
  increment('sendam_exceptions_total', { source: context.source || 'application' });
  const endpoint = process.env.ERROR_MONITOR_WEBHOOK_URL;
  if (!endpoint) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ERROR_MONITOR_TIMEOUT_MS || 3000));
  timeout.unref();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(process.env.ERROR_MONITOR_TOKEN && { authorization: `Bearer ${process.env.ERROR_MONITOR_TOKEN}` }),
      },
      body: JSON.stringify(logger.sanitize({
        event: 'sendam_exception',
        service: process.env.SERVICE_NAME || 'sendam-api',
        environment: process.env.NODE_ENV || 'development',
        release: process.env.RELEASE_SHA,
        error,
        context,
      })),
    });
    if (!response.ok) throw new Error(`monitor returned HTTP ${response.status}`);
    return true;
  } catch (reportingError) {
    logger.error('error_monitor_delivery_failed', { message: reportingError.message });
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const initializeErrorMonitoring = () => {
  if (initialized) return;
  initialized = true;
  process.on('unhandledRejection', (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    logger.error('unhandled_rejection', normalized);
    captureException(normalized, { source: 'unhandled_rejection' });
  });
  process.on('uncaughtException', async (error) => {
    logger.error('uncaught_exception', error);
    await captureException(error, { source: 'uncaught_exception' });
    process.exit(1);
  });
};

module.exports = { captureException, initializeErrorMonitoring };

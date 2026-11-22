'use strict';

// OpenTelemetry distributed tracing for the WhatsApp -> Deepgram -> backend ->
// Horizon lifecycle.
//
// Tracing is opt-in. It starts when OTEL_EXPORTER_OTLP_ENDPOINT (or
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is set, or OTEL_TRACING_ENABLED=true, and
// is disabled by OTEL_TRACING_ENABLED=false or OTEL_SDK_DISABLED=true. When
// disabled, every helper here is a cheap no-op.
//
// Coverage:
//   - Express and inbound/outbound HTTP (WhatsApp webhook, Deepgram, Horizon,
//     including `traceparent` on outgoing requests): auto-instrumentation.
//   - Prisma and PostgreSQL: @prisma/instrumentation and instrumentation-pg.
//   - BullMQ: trace context is injected into job data at enqueue time and
//     extracted when the worker processes the job (see queue.service.js), so
//     the worker span is a child of the webhook request.
//   - @stellar/stellar-sdk: `submitTransaction` and `fetchBaseFee` spans via
//     instrumentStellarServerTracing().

const { context, propagation, trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('../utils/logger');

const TRACER_NAME = 'sendam-api';
const TRACE_CONTEXT_FIELD = 'traceContext';

const truthy = (value) => String(value || '').trim().toLowerCase() === 'true';
const falsy = (value) => String(value || '').trim().toLowerCase() === 'false';

const isTracingEnabled = (env = process.env) => {
  if (truthy(env.OTEL_SDK_DISABLED) || falsy(env.OTEL_TRACING_ENABLED)) return false;
  if (truthy(env.OTEL_TRACING_ENABLED)) return true;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
};

// Loaded lazily so a process with tracing disabled never pays the import cost.
const defaultSdkFactory = ({ serviceName }) => {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { PrismaInstrumentation } = require('@prisma/instrumentation');

  return new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });
};

let activeSdk = null;

/**
 * Start tracing. Must run before `http`, `express`, `pg` or Prisma are
 * required so their instrumentation can patch them. Never throws: a tracing
 * failure must not stop the API from serving payments.
 */
const startTracing = ({
  env = process.env,
  serviceName = env.OTEL_SERVICE_NAME || env.SERVICE_NAME || 'sendam-api',
  sdkFactory = defaultSdkFactory,
} = {}) => {
  if (activeSdk) return { enabled: true, shutdown: shutdownTracing };
  if (!isTracingEnabled(env)) return { enabled: false, shutdown: async () => {} };

  try {
    const sdk = sdkFactory({ serviceName });
    sdk.start();
    activeSdk = sdk;
    // Flush buffered spans on termination without taking over exit handling.
    process.once('SIGTERM', () => { shutdownTracing(); });
    logger.info('tracing_started', { serviceName });
    return { enabled: true, shutdown: shutdownTracing };
  } catch (error) {
    logger.error('tracing_start_failed', { message: error.message });
    return { enabled: false, shutdown: async () => {} };
  }
};

const shutdownTracing = async () => {
  const sdk = activeSdk;
  activeSdk = null;
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    logger.warn('tracing_shutdown_failed', { message: error.message });
  }
};

const getTracer = () => trace.getTracer(TRACER_NAME);

/** Serialize the active trace context (`traceparent`, `tracestate`) into a plain object. */
const injectTraceContext = (carrier = {}) => {
  propagation.inject(context.active(), carrier);
  return carrier;
};

/** Rebuild a context from a carrier produced by injectTraceContext. */
const extractTraceContext = (carrier) => (
  carrier && typeof carrier === 'object' ? propagation.extract(context.active(), carrier) : context.active()
);

/**
 * Run `fn` inside a new span. The span records exceptions and ends whether
 * `fn` resolves or throws; the original result or error is always preserved.
 */
const withSpan = async (name, fn, { attributes, kind = SpanKind.INTERNAL, parent } = {}) => {
  const parentContext = parent || context.active();
  const span = getTracer().startSpan(name, { kind, attributes }, parentContext);
  try {
    return await context.with(trace.setSpan(parentContext, span), () => fn(span));
  } catch (error) {
    span.recordException({ name: error?.name, message: logger.sanitize(String(error?.message || '')) });
    span.setStatus({ code: SpanStatusCode.ERROR, message: logger.sanitize(String(error?.message || '')) });
    throw error;
  } finally {
    span.end();
  }
};

/**
 * Wrap Horizon `submitTransaction` and `fetchBaseFee` in spans so the trace
 * ends with the on-chain confirmation (ledger and hash on the span). Idempotent.
 */
const instrumentStellarServerTracing = (server) => {
  if (!server || server.__stellarTracingInstrumented) return server;

  const submit = server.submitTransaction?.bind(server);
  if (submit) {
    server.submitTransaction = (...args) => withSpan('stellar.submit_transaction', async (span) => {
      const response = await submit(...args);
      if (response?.hash) span.setAttribute('stellar.tx.hash', response.hash);
      if (response?.ledger) span.setAttribute('stellar.ledger', Number(response.ledger));
      if (typeof response?.successful === 'boolean') span.setAttribute('stellar.tx.successful', response.successful);
      return response;
    }, { kind: SpanKind.CLIENT, attributes: { 'peer.service': 'stellar-horizon' } });
  }

  const fetchBaseFee = server.fetchBaseFee?.bind(server);
  if (fetchBaseFee) {
    server.fetchBaseFee = (...args) => withSpan('stellar.fetch_base_fee', async (span) => {
      const fee = await fetchBaseFee(...args);
      span.setAttribute('stellar.base_fee_stroops', Number(fee));
      return fee;
    }, { kind: SpanKind.CLIENT, attributes: { 'peer.service': 'stellar-horizon' } });
  }

  Object.defineProperty(server, '__stellarTracingInstrumented', { value: true });
  return server;
};

module.exports = {
  TRACE_CONTEXT_FIELD,
  extractTraceContext,
  getTracer,
  injectTraceContext,
  instrumentStellarServerTracing,
  isTracingEnabled,
  shutdownTracing,
  startTracing,
  withSpan,
};

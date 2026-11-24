const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { context, propagation, trace, SpanKind } = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace');

const {
  extractTraceContext,
  injectTraceContext,
  instrumentStellarServerTracing,
  isTracingEnabled,
  startTracing,
  withSpan,
} = require('../src/observability/tracing');

const exporter = new InMemorySpanExporter();
let provider;
let contextManager;

before(() => {
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
});

after(async () => {
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

const spansByName = () => Object.fromEntries(exporter.getFinishedSpans().map((span) => [span.name, span]));
const parentIdOf = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;

test('tracing is opt-in and respects explicit disable flags', () => {
  assert.equal(isTracingEnabled({}), false);
  assert.equal(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }), true);
  assert.equal(isTracingEnabled({ OTEL_TRACING_ENABLED: 'true' }), true);
  assert.equal(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_TRACING_ENABLED: 'false' }), false);
  assert.equal(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SDK_DISABLED: 'true' }), false);
});

test('startTracing does nothing when disabled and never throws when the SDK fails', async () => {
  let built = false;
  const off = startTracing({ env: {}, sdkFactory: () => { built = true; } });
  assert.equal(off.enabled, false);
  assert.equal(built, false);

  const broken = startTracing({
    env: { OTEL_TRACING_ENABLED: 'true' },
    sdkFactory: () => { throw new Error('collector misconfigured'); },
  });
  assert.equal(broken.enabled, false);
  await broken.shutdown();
});

test('startTracing starts the SDK once when enabled', async () => {
  const calls = [];
  const sdk = { start: () => calls.push('start'), shutdown: async () => { calls.push('shutdown'); } };
  const first = startTracing({ env: { OTEL_TRACING_ENABLED: 'true' }, serviceName: 'svc', sdkFactory: () => sdk });
  const second = startTracing({ env: { OTEL_TRACING_ENABLED: 'true' }, sdkFactory: () => { throw new Error('should not rebuild'); } });
  assert.equal(first.enabled, true);
  assert.equal(second.enabled, true);
  await first.shutdown();
  assert.deepEqual(calls, ['start', 'shutdown']);
  process.removeAllListeners('SIGTERM');
});

test('trace context survives enqueue -> worker as one trace via traceparent', async () => {
  let carrier;
  await withSpan('POST /webhook', async () => {
    carrier = injectTraceContext({});
  }, { kind: SpanKind.SERVER });

  assert.match(carrier.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

  await withSpan('queue.process whatsapp-inbound', async () => {}, {
    kind: SpanKind.CONSUMER,
    parent: extractTraceContext(carrier),
  });

  const spans = spansByName();
  const webhook = spans['POST /webhook'];
  const worker = spans['queue.process whatsapp-inbound'];
  assert.equal(worker.spanContext().traceId, webhook.spanContext().traceId);
  assert.equal(parentIdOf(worker), webhook.spanContext().spanId);
});

test('missing or invalid carriers fall back to the active context', async () => {
  assert.equal(extractTraceContext(undefined), context.active());
  assert.equal(extractTraceContext('nope'), context.active());
});

test('withSpan records errors, redacts secrets, and rethrows the original error', async () => {
  const error = new Error('failed with token=super-secret');
  await assert.rejects(() => withSpan('op', async () => { throw error; }), (thrown) => thrown === error);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.status.code, 2);
  assert.doesNotMatch(JSON.stringify(span.status) + JSON.stringify(span.events), /super-secret/);
});

test('Horizon submission is traced end to end with ledger and hash on the span', async () => {
  const server = instrumentStellarServerTracing({
    submitTransaction: async () => ({ hash: 'deadbeef', ledger: 5123, successful: true }),
    fetchBaseFee: async () => '100',
  });

  await withSpan('queue.process whatsapp-inbound', async () => {
    assert.equal(await server.fetchBaseFee(), '100');
    const response = await server.submitTransaction({});
    assert.equal(response.hash, 'deadbeef');
  });

  const spans = spansByName();
  const submit = spans['stellar.submit_transaction'];
  assert.equal(submit.attributes['stellar.tx.hash'], 'deadbeef');
  assert.equal(submit.attributes['stellar.ledger'], 5123);
  assert.equal(submit.attributes['stellar.tx.successful'], true);
  assert.equal(spans['stellar.fetch_base_fee'].attributes['stellar.base_fee_stroops'], 100);
  assert.equal(submit.spanContext().traceId, spans['queue.process whatsapp-inbound'].spanContext().traceId);
});

test('a failed Horizon submission marks the span as an error', async () => {
  const server = instrumentStellarServerTracing({
    submitTransaction: async () => { throw new Error('tx_bad_auth'); },
  });
  await assert.rejects(() => server.submitTransaction({}), /tx_bad_auth/);
  assert.equal(spansByName()['stellar.submit_transaction'].status.code, 2);
});

test('the shared Horizon server is instrumented for tracing', () => {
  const { server } = require('../src/config/stellar');
  assert.equal(server.__stellarTracingInstrumented, true);
});

test('queue enqueue carries traceparent and the processor span joins the same trace', async () => {
  const { enqueue, registerProcessor } = require('../src/queues/queue.service');
  let seenData;
  const done = new Promise((resolve) => {
    registerProcessor('trace-test-queue', async (job) => { seenData = job.data; resolve(); });
  });

  await withSpan('POST /webhook', async () => {
    await enqueue('trace-test-queue', 'job', { hello: 'world' }, { jobId: 'trace-job-1' });
  }, { kind: SpanKind.SERVER });
  await done;
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(seenData.traceContext.traceparent, /^00-/);
  const spans = spansByName();
  const consumer = spans['queue.process trace-test-queue'];
  assert.equal(consumer.spanContext().traceId, spans['POST /webhook'].spanContext().traceId);
  assert.equal(parentIdOf(consumer), spans['POST /webhook'].spanContext().spanId);
});

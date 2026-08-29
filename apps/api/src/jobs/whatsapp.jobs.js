const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
const { withOrdering, createInMemoryOrderingStore, createDistributedOrderingStore } = require('../queues/ordering.service');
const config = require('../config/env');
const logger = require('../utils/logger');
const prisma = require('../common/prisma');

// `orderingStore` is injectable so tests can exercise the ordering gate directly.
// In production, the shared distributed (Redis-backed) store is REQUIRED to
// ensure per-sender serialization across worker replicas. The in-memory store
// is only permitted when NODE_ENV !== 'production'.
const registerWhatsAppJobs = ({ orderingStore } = {}) => {
  if (!orderingStore) {
    if (config.isProduction) {
      // Fail fast in production if shared ordering is not configured
      const redisUrl = config.redis?.url;
      if (!redisUrl) {
        throw new Error('Production requires REDIS_URL for shared WhatsApp message ordering. In-memory store is not allowed in production.');
      }
      orderingStore = createDistributedOrderingStore();
      logger.info('WhatsApp ordering using distributed (Redis-backed) store');
    } else {
      orderingStore = createInMemoryOrderingStore();
      logger.info('WhatsApp ordering using in-memory store (development/test)');
    }
  }
  const processInboundMessage = async (job) => {
    const { from, whatsappName, text, mediaId, messageType, whatsappMessageId } = job.data;
    if (whatsappMessageId) {
      // This update occurs before side effects. If it fails BullMQ retries the
      // job; an API crash after enqueue can therefore still be reconciled.
      await prisma.processedMessage.update({
        where: { messageId: whatsappMessageId },
        data: { status: 'processing', lastError: null },
      });
    }

    if (messageType === 'audio' || messageType === 'voice') {
      await processVoiceMessage({ phoneNumber: from, whatsappName, mediaId, whatsappMessageId });
    } else {
      await processMessage(from, whatsappName, text);
    }

    if (whatsappMessageId) {
      try {
        await prisma.processedMessage.update({
          where: { messageId: whatsappMessageId },
          data: { status: 'completed', lastError: null },
        });
      } catch (error) {
        // Processing already completed; retrying it solely because telemetry
        // failed could duplicate replies. Leave "processing" for recovery.
        logger.error('message_delivery_completion_update_failed', {
          messageId: whatsappMessageId,
          message: error.message,
        });
      }
    }
  };

  // Preserves per-customer (canonical sender) message ordering: same-sender
  // jobs run strictly in provider-timestamp order and one at a time, while
  // different senders keep the worker's full configured parallelism. See
  // apps/api/src/queues/ordering.service.js for the design.
  const orderedProcessor = withOrdering(processInboundMessage, {
    store: orderingStore,
    requeueDelayMs: config.whatsappOrdering.requeueDelayMs,
    maxRequeues: config.whatsappOrdering.maxRequeues,
  });

  const worker = registerProcessor('whatsapp-inbound', orderedProcessor);

  logger.info('WhatsApp queue processor registered');
  return worker;
};

module.exports = {
  registerWhatsAppJobs,
};

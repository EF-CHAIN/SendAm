const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const prisma = require('../common/prisma');
const { enqueue } = require('../queues/queue.service');

const RETRYABLE_META_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const isRetryableMetaFailure = (error) => {
  const status = Number(error?.response?.status || error?.status || 0);
  if (RETRYABLE_META_STATUS_CODES.has(status)) return true;
  const haystack = `${error?.message || ''} ${JSON.stringify(error?.response?.data || {})}`.toLowerCase();
  return /(timeout|temporar|rate limit|too many|throttl|network|unavailable|busy)/i.test(haystack);
};

const deliverMetaTextMessage = async (to, body, axiosImpl = axios) => {
  const url = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: false,
      body,
    },
  };

  const response = await axiosImpl.post(url, payload, {
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data;
};

const persistOutboundNotification = async ({ to, body, prismaClient = prisma, error = null, retryable = false }) => {
  const notificationClient = prismaClient.notification;
  if (!notificationClient?.create) return null;

  const created = await notificationClient.create({
    data: {
      userId: null,
      channel: 'whatsapp',
      type: 'outbound_message',
      recipient: to,
      body,
      status: retryable ? 'queued' : 'failed',
      error: error ? String(error.message || error.response?.data || error) : null,
      metadata: {
        retryable,
        errorCode: error?.response?.data?.error?.code || error?.response?.data?.error?.error_subcode || null,
        retryCount: 0,
      },
    },
  });

  if (retryable) {
    await enqueue('whatsapp-outbound-retry', 'notification.retry', {
      notificationId: created.id,
      to,
      body,
      attempts: 0,
    });
  }

  return created;
};

const retryOutboundNotification = async ({ notificationId, to, body, attempts = 0, axiosImpl = axios, prismaClient = prisma }) => {
  const notification = await prismaClient.notification.findUnique({ where: { id: notificationId } });
  if (!notification) return { status: 'missing' };

  if (['failed', 'dead_letter', 'sent'].includes(notification.status)) {
    return { status: notification.status, notification };
  }

  try {
    const response = await deliverMetaTextMessage(to, body, axiosImpl);
    const providerMessageId = response?.messages?.[0]?.id || response?.message_id || null;

    await prismaClient.notification.update({
      where: { id: notificationId },
      data: {
        status: 'sent',
        providerMessageId,
        metadata: {
          ...(notification.metadata || {}),
          lastAttemptAt: new Date().toISOString(),
          retryCount: Number(attempts || 0),
        },
      },
    });

    return { status: 'sent', notificationId, providerMessageId };
  } catch (error) {
    const retryable = isRetryableMetaFailure(error);
    const nextAttempts = attempts + 1;
    const isTerminal = nextAttempts >= 4;

    await prismaClient.notification.update({
      where: { id: notificationId },
      data: {
        status: isTerminal ? 'dead_letter' : 'queued',
        error: String(error.message || error.response?.data || error),
        metadata: {
          ...(notification.metadata || {}),
          retryable,
          lastAttemptAt: new Date().toISOString(),
          retryCount: nextAttempts,
          lastError: String(error.message || error.response?.data || error),
        },
      },
    });

    if (retryable && !isTerminal) {
      await enqueue('whatsapp-outbound-retry', 'notification.retry', {
        notificationId,
        to,
        body,
        attempts: nextAttempts,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 15000 },
      });
    }

    return { status: isTerminal ? 'dead_letter' : 'queued', notificationId, retryable };
  }
};

const sendTextMessage = async (to, body, options = {}) => {
  const {
    messageTransport = config.messageTransport,
    prisma: prismaClient = prisma,
    axiosImpl = axios,
    enqueue: enqueueFn = enqueue,
  } = options;

  try {
    if (messageTransport === 'sim') {
      const db = prismaClient || prisma;
      const result = await db.simMessage.create({
        data: {
          phoneNumber: to,
          direction: 'out',
          text: body,
        },
      });
      return result;
    }

    const response = await deliverMetaTextMessage(to, body, axiosImpl);
    return response;
  } catch (error) {
    logger.error('WhatsApp API Error:', error.response?.data || error.message);
    const retryable = isRetryableMetaFailure(error);
    const notification = await persistOutboundNotification({ to, body, prismaClient, error, retryable });
    if (!notification && retryable) {
      logger.warn('Could not create outbound notification for retriable WhatsApp failure.');
    }
    return null;
  }
};

module.exports = {
  sendTextMessage,
  retryOutboundNotification,
  isRetryableMetaFailure,
};

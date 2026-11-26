'use strict';

/**
 * Conversational Finite State Machine (FSM) with Redis Session Persistence
 *
 * Implements a state machine for multi-step conversational flows:
 *   - States: IDLE, AWAITING_AMOUNT, AWAITING_CONFIRMATION, AWAITING_PIN
 *   - Persists state and session context in Redis with a 10-minute TTL
 *   - Preserves state across server restarts
 *   - Handles inactivity timeouts cleanly with informative resume prompts
 *
 * Issue: #975
 */

const { canonicalizePhoneNumber } = require('../utils/validators');
const { getRedisConnection } = require('../config/redis');
const config = require('../config/env');
const logger = require('../utils/logger');

// ── Constants & States ────────────────────────────────────────────────────────

const STATES = Object.freeze({
  IDLE: 'IDLE',
  AWAITING_AMOUNT: 'AWAITING_AMOUNT',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  AWAITING_PIN: 'AWAITING_PIN',
});

const SESSION_TTL_SECONDS = 10 * 60; // 10 minutes
const EXPIRED_ARCHIVE_TTL_SECONDS = 30 * 60; // 30 minutes archive for resume prompt

const KEY_PREFIX = 'whatsapp:fsm:session:';
const EXPIRED_KEY_PREFIX = 'whatsapp:fsm:expired:';

// In-memory fallback store when Redis is unavailable or in memory-only test environments
const memorySessionStore = new Map();
const memoryExpiredStore = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

const getSessionKey = (phoneNumber) => `${KEY_PREFIX}${canonicalizePhoneNumber(phoneNumber)}`;
const getExpiredKey = (phoneNumber) => `${EXPIRED_KEY_PREFIX}${canonicalizePhoneNumber(phoneNumber)}`;

const getActiveRedis = (injectedRedis) => {
  if (injectedRedis) return injectedRedis;
  try {
    const redis = getRedisConnection(config);
    if (redis && (redis.status === 'ready' || redis.status === 'connect')) {
      return redis;
    }
    return redis || null;
  } catch {
    return null;
  }
};

/**
 * Resets the in-memory fallback stores (useful for test isolation).
 */
const _resetMemoryStores = () => {
  memorySessionStore.clear();
  memoryExpiredStore.clear();
};

/**
 * Valid transitions between states.
 */
const ALLOWED_TRANSITIONS = {
  [STATES.IDLE]: [STATES.IDLE, STATES.AWAITING_AMOUNT, STATES.AWAITING_CONFIRMATION],
  [STATES.AWAITING_AMOUNT]: [STATES.AWAITING_CONFIRMATION, STATES.IDLE],
  [STATES.AWAITING_CONFIRMATION]: [STATES.AWAITING_PIN, STATES.AWAITING_AMOUNT, STATES.IDLE],
  [STATES.AWAITING_PIN]: [STATES.IDLE, STATES.AWAITING_CONFIRMATION],
};

const isValidTransition = (fromState, toState) => {
  if (toState === STATES.IDLE) return true; // Can always cancel / reset to IDLE
  const allowed = ALLOWED_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.includes(toState));
};

// ── Session Storage & Retrieval ───────────────────────────────────────────────

/**
 * Saves a session to Redis with the configured 10-minute TTL.
 */
const saveSession = async (phoneNumber, sessionData, { redis: injectedRedis, ttlSeconds = SESSION_TTL_SECONDS } = {}) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const key = getSessionKey(canonicalPhone);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const record = {
    phoneNumber: canonicalPhone,
    state: sessionData.state || STATES.IDLE,
    context: sessionData.context || {},
    updatedAt: now.toISOString(),
    expiresAt,
    previousState: sessionData.previousState || null,
  };

  const serialized = JSON.stringify(record);
  const redis = getActiveRedis(injectedRedis);

  if (redis && typeof redis.set === 'function') {
    try {
      await redis.set(key, serialized, 'EX', ttlSeconds);
      return record;
    } catch (err) {
      logger.warn('fsm_redis_save_failed_fallback_memory', { key, error: err.message });
    }
  }

  // Fallback to in-memory store
  memorySessionStore.set(key, { data: record, expiresAtMs: now.getTime() + ttlSeconds * 1000 });
  return record;
};

/**
 * Retrieves the active session for a phone number.
 * Checks for expiration and archives expired sessions for informative resume prompts.
 */
const getSession = async (phoneNumber, { redis: injectedRedis, now = Date.now() } = {}) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const key = getSessionKey(canonicalPhone);
  const redis = getActiveRedis(injectedRedis);

  let raw = null;

  if (redis && typeof redis.get === 'function') {
    try {
      raw = await redis.get(key);
    } catch (err) {
      logger.warn('fsm_redis_get_failed_fallback_memory', { key, error: err.message });
    }
  }

  if (!raw && memorySessionStore.has(key)) {
    const mem = memorySessionStore.get(key);
    if (mem.expiresAtMs < now) {
      memorySessionStore.delete(key);
      // Archive expired session
      memoryExpiredStore.set(getExpiredKey(canonicalPhone), {
        data: mem.data,
        expiresAtMs: now + EXPIRED_ARCHIVE_TTL_SECONDS * 1000,
      });
      return {
        phoneNumber: canonicalPhone,
        state: STATES.IDLE,
        context: {},
        expired: true,
        previousSession: mem.data,
      };
    }
    return mem.data;
  }

  if (!raw) {
    // Check if there is an archived expired session
    const expiredRecord = await getExpiredSession(canonicalPhone, { redis });
    if (expiredRecord) {
      return {
        phoneNumber: canonicalPhone,
        state: STATES.IDLE,
        context: {},
        expired: true,
        previousSession: expiredRecord,
      };
    }

    return {
      phoneNumber: canonicalPhone,
      state: STATES.IDLE,
      context: {},
      expired: false,
      previousSession: null,
    };
  }

  try {
    const session = JSON.parse(raw);
    const expireTime = new Date(session.expiresAt).getTime();

    if (expireTime < now) {
      // Session has expired
      await clearSession(canonicalPhone, { redis, archiveExpired: true, expiredSession: session });
      return {
        phoneNumber: canonicalPhone,
        state: STATES.IDLE,
        context: {},
        expired: true,
        previousSession: session,
      };
    }

    return session;
  } catch (err) {
    logger.error('fsm_parse_session_failed', { key, error: err.message });
    return {
      phoneNumber: canonicalPhone,
      state: STATES.IDLE,
      context: {},
      expired: false,
      previousSession: null,
    };
  }
};

/**
 * Archives an expired session so the user can be offered a resume prompt.
 */
const archiveExpiredSession = async (phoneNumber, sessionData, { redis: injectedRedis } = {}) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const key = getExpiredKey(canonicalPhone);
  const redis = getActiveRedis(injectedRedis);
  const serialized = JSON.stringify(sessionData);

  if (redis && typeof redis.set === 'function') {
    try {
      await redis.set(key, serialized, 'EX', EXPIRED_ARCHIVE_TTL_SECONDS);
      return;
    } catch (err) {
      logger.warn('fsm_redis_archive_expired_failed', { key, error: err.message });
    }
  }

  memoryExpiredStore.set(key, {
    data: sessionData,
    expiresAtMs: Date.now() + EXPIRED_ARCHIVE_TTL_SECONDS * 1000,
  });
};

/**
 * Retrieves an archived expired session if available.
 */
const getExpiredSession = async (phoneNumber, { redis: injectedRedis } = {}) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const key = getExpiredKey(canonicalPhone);
  const redis = getActiveRedis(injectedRedis);

  if (redis && typeof redis.get === 'function') {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn('fsm_redis_get_expired_failed', { key, error: err.message });
    }
  }

  const mem = memoryExpiredStore.get(key);
  if (mem) {
    if (mem.expiresAtMs > Date.now()) return mem.data;
    memoryExpiredStore.delete(key);
  }

  return null;
};

/**
 * Clears an active session from Redis.
 */
const clearSession = async (
  phoneNumber,
  { redis: injectedRedis, archiveExpired = false, expiredSession = null } = {}
) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const key = getSessionKey(canonicalPhone);
  const redis = getActiveRedis(injectedRedis);

  if (archiveExpired && expiredSession) {
    await archiveExpiredSession(canonicalPhone, expiredSession, { redis });
  }

  if (redis && typeof redis.del === 'function') {
    try {
      await redis.del(key);
    } catch (err) {
      logger.warn('fsm_redis_clear_failed', { key, error: err.message });
    }
  }

  memorySessionStore.delete(key);
};

/**
 * Clears any archived expired session.
 */
const clearExpiredArchive = async (phoneNumber, { redis: injectedRedis } = {}) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const key = getExpiredKey(canonicalPhone);
  const redis = getActiveRedis(injectedRedis);

  if (redis && typeof redis.del === 'function') {
    try {
      await redis.del(key);
    } catch {
      // ignore
    }
  }

  memoryExpiredStore.delete(key);
};

// ── State Transitions ─────────────────────────────────────────────────────────

/**
 * Executes a validated state transition and persists the updated session context to Redis.
 */
const transition = async (
  phoneNumber,
  toState,
  contextUpdates = {},
  { redis, force = false } = {}
) => {
  const currentSession = await getSession(phoneNumber, { redis });
  const fromState = currentSession.state || STATES.IDLE;

  if (!force && !isValidTransition(fromState, toState)) {
    throw new Error(`Invalid FSM transition from ${fromState} to ${toState}`);
  }

  if (toState === STATES.IDLE) {
    await clearSession(phoneNumber, { redis });
    return {
      phoneNumber: canonicalizePhoneNumber(phoneNumber),
      state: STATES.IDLE,
      context: {},
      previousState: fromState,
    };
  }

  const mergedContext = {
    ...currentSession.context,
    ...contextUpdates,
  };

  const updatedSession = {
    state: toState,
    context: mergedContext,
    previousState: fromState,
  };

  return await saveSession(phoneNumber, updatedSession, { redis });
};

// ── Prompts & Inactivity Handling ─────────────────────────────────────────────

/**
 * Generates an informative prompt offering to resume an expired session.
 */
const getResumePrompt = (expiredSession, locale = 'en') => {
  const ctx = expiredSession?.context || {};
  const recipient = ctx.recipient || ctx.alias || 'the recipient';
  const amount = ctx.amount ? `${ctx.amount} ${ctx.asset || 'XLM'}` : 'your transaction';

  if (locale === 'fr') {
    return `Votre session précédente pour envoyer ${amount} à ${recipient} a expiré en raison d'inactivité. Répondez OUI pour reprendre où vous vous êtes arrêté, ou NON pour annuler.`;
  }
  if (locale === 'es') {
    return `Su sesión anterior para enviar ${amount} a ${recipient} expiró por inactividad. Responda SÍ para reanudar donde lo dejó, o NO para cancelar.`;
  }

  return `Your previous session to send ${amount} to ${recipient} timed out due to inactivity. Reply YES to resume where you left off, or CANCEL to start fresh.`;
};

/**
 * Resumes an expired session, restoring its context and resetting the 10-minute TTL.
 */
const resumeSession = async (phoneNumber, { redis } = {}) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const expired = await getExpiredSession(canonicalPhone, { redis });
  if (!expired) return null;

  const restoredState = expired.state && expired.state !== STATES.IDLE
    ? expired.state
    : (expired.previousState || STATES.AWAITING_CONFIRMATION);

  await clearExpiredArchive(canonicalPhone, { redis });

  return await saveSession(
    canonicalPhone,
    {
      state: restoredState,
      context: expired.context || {},
      previousState: STATES.IDLE,
    },
    { redis }
  );
};

// ── Conversational Flow Driver ────────────────────────────────────────────────

/**
 * Processes a message against the conversational FSM.
 * Handles:
 *   - Inactivity detection and resume prompt
 *   - Resume confirmation
 *   - Cancellation
 *   - Step-by-step state progression
 */
const handleFsmMessage = async (
  phoneNumber,
  text,
  {
    notify,
    redis,
    user,
    locale = 'en',
    onComplete,
    onCancel,
    onRequestQuote,
  } = {}
) => {
  const trimmed = String(text || '').trim();
  const lower = trimmed.toLowerCase();
  const session = await getSession(phoneNumber, { redis });

  // 1. Check for expired session needing a resume prompt
  if (session.expired && session.previousSession) {
    if (['yes', 'oui', 'si', 'resume', 'y'].includes(lower)) {
      const resumed = await resumeSession(phoneNumber, { redis });
      if (resumed) {
        const ctx = resumed.context || {};
        if (resumed.state === STATES.AWAITING_AMOUNT) {
          await notify(phoneNumber, `Resumed. How much would you like to send to ${ctx.recipient || 'the recipient'}?`);
          return { handled: true, state: resumed.state, session: resumed };
        }
        if (resumed.state === STATES.AWAITING_CONFIRMATION) {
          const amt = ctx.amount ? `${ctx.amount} ${ctx.asset || 'XLM'}` : '';
          await notify(phoneNumber, `Resumed. Confirm send ${amt} to ${ctx.recipient || ctx.alias}? Reply YES to proceed or NO to cancel.`);
          return { handled: true, state: resumed.state, session: resumed };
        }
        if (resumed.state === STATES.AWAITING_PIN) {
          await notify(phoneNumber, `Resumed. Please enter your 4-digit PIN to authorize the payment of ${ctx.amount} ${ctx.asset || 'XLM'} to ${ctx.recipient || ctx.alias}.`);
          return { handled: true, state: resumed.state, session: resumed };
        }
      }
    } else if (['no', 'non', 'cancel', 'annuler', 'n'].includes(lower)) {
      await clearExpiredArchive(phoneNumber, { redis });
      await notify(phoneNumber, 'Cancelled. How can I help you today?');
      return { handled: true, state: STATES.IDLE, session: null };
    } else {
      // Informative resume prompt
      await notify(phoneNumber, getResumePrompt(session.previousSession, locale));
      return { handled: true, state: STATES.IDLE, promptType: 'resume_inquiry', session };
    }
  }

  // 2. Cancellation at any state
  if (session.state !== STATES.IDLE && ['cancel', 'no', 'stop', 'annuler'].includes(lower)) {
    await clearSession(phoneNumber, { redis });
    if (typeof onCancel === 'function') {
      await onCancel(session);
    }
    await notify(phoneNumber, 'Transaction cancelled. How else can I help you?');
    return { handled: true, state: STATES.IDLE, session: null };
  }

  // 3. State-specific processing
  switch (session.state) {
    case STATES.AWAITING_AMOUNT: {
      const amountMatch = trimmed.match(/^([\d.]+)\s*([a-zA-Z]{2,5})?$/);
      if (!amountMatch) {
        await notify(phoneNumber, 'Please enter a valid amount (e.g., 50 or 50 XLM) or reply cancel.');
        return { handled: true, state: STATES.AWAITING_AMOUNT, session };
      }

      const amount = amountMatch[1];
      const asset = amountMatch[2] ? amountMatch[2].toUpperCase() : (session.context.asset || 'XLM');

      let quote = null;
      if (typeof onRequestQuote === 'function') {
        quote = await onRequestQuote({ amount, asset, context: session.context });
      }

      const nextSession = await transition(
        phoneNumber,
        STATES.AWAITING_CONFIRMATION,
        {
          amount,
          asset,
          quoteId: quote?.id,
          quoteFee: quote?.fee,
          quoteExpiresAt: quote?.expiresAt,
        },
        { redis }
      );

      const recipient = nextSession.context.recipient || nextSession.context.alias || 'recipient';
      const feeLine = quote?.fee ? `\nFee: ${quote.fee} ${asset}` : '';
      await notify(
        phoneNumber,
        `Please confirm: Send ${amount} ${asset} to ${recipient}.${feeLine}\nReply YES to confirm or NO to cancel.`
      );
      return { handled: true, state: STATES.AWAITING_CONFIRMATION, session: nextSession };
    }

    case STATES.AWAITING_CONFIRMATION: {
      if (['yes', 'oui', 'si', 'confirm', 'y'].includes(lower)) {
        const nextSession = await transition(
          phoneNumber,
          STATES.AWAITING_PIN,
          { confirmedAt: new Date().toISOString() },
          { redis }
        );
        await notify(phoneNumber, 'Please enter your 4-digit PIN to authorize this transfer:');
        return { handled: true, state: STATES.AWAITING_PIN, session: nextSession };
      }
      await notify(phoneNumber, 'Please reply YES to authorize the transfer or NO to cancel.');
      return { handled: true, state: STATES.AWAITING_CONFIRMATION, session };
    }

    case STATES.AWAITING_PIN: {
      if (/^\d{4,6}$/.test(trimmed)) {
        if (typeof onComplete === 'function') {
          const result = await onComplete({
            pin: trimmed,
            session,
            user,
          });
          if (result && result.error) {
            await notify(phoneNumber, result.error);
            return { handled: true, state: STATES.AWAITING_PIN, session, error: result.error };
          }
        }
        await clearSession(phoneNumber, { redis });
        return { handled: true, state: STATES.IDLE, session: null, completed: true };
      }
      await notify(phoneNumber, 'Please enter a valid PIN (4 to 6 digits) or reply cancel.');
      return { handled: true, state: STATES.AWAITING_PIN, session };
    }

    case STATES.IDLE:
    default:
      return { handled: false, state: STATES.IDLE, session };
  }
};

module.exports = {
  STATES,
  SESSION_TTL_SECONDS,
  saveSession,
  getSession,
  clearSession,
  transition,
  resumeSession,
  getResumePrompt,
  handleFsmMessage,
  _resetMemoryStores,
};

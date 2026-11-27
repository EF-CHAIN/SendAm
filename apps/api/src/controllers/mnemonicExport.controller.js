'use strict';

// Secure recovery-phrase export API (#960).
//
// `wallet/mnemonic.service.js` (PR #1065) already holds the whole export
// POLICY: a cryptographically random challenge whose HMAC alone is stored, a
// short expiry, bounded attempts, timing-safe comparison, a PIN factor routed
// through the shared lockout budget, and an atomic single-use claim. What it
// never had was a way for a user to reach it. This controller is that
// boundary, and it is deliberately thin: it resolves and authorizes, maps
// errors to status codes, and leaves every policy decision to the service.
//
// ── Two things this layer owns, because the service cannot ───────────────
//
//  1. GRANT OWNERSHIP. `requestExport` checks that the wallet belongs to the
//     caller, but `verifyExportChallenge` and `consumeExport` take a bare
//     `grantId` and never look at who is asking — `consumeExport` in
//     particular performs no caller check at all. Reached over HTTP that
//     would let any authenticated session claim another user's authorized
//     grant and walk away with their secret key. Every handler here that
//     takes a `grantId` therefore loads the grant and refuses unless it
//     belongs to `req.restUser`. This is the single most important line in
//     the file; see `assertOwnedGrant`.
//
//  2. NOT CACHING THE PAYLOAD. The claim response carries key material
//     exactly once, so it is sent with `Cache-Control: no-store` and friends.
//     A proxy or browser that retains it would turn a single-use export into
//     a replayable one.
//
// ── The out-of-band channel is WhatsApp, and is reported as such ─────────
//
// Issue #960 asks for SMS. There is still no SMS provider in this repository:
// no `twilio`/`termii`/`africastalking`-class dependency, no SMS service
// module, and the only mention of SMS in `src/` is a docstring in
// `compliance/pinLockout.js` whose implementation defaults to `whatsapp`.
// The product's real out-of-band channel to a user is the WhatsApp Cloud API,
// keyed by the same phone number, so that is what delivers the challenge.
//
// Rather than let a reader assume otherwise, the channel is named in the API
// response (`channel`) and in the audit record. Substituting a real SMS
// provider means passing a different `deliverChallenge` — no policy below
// changes. Whether WhatsApp is an acceptable second factor for this product
// is a maintainer decision, recorded in the PR, not settled here.

const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const whatsapp = require('../services/whatsapp.service');
const { writeAuditLog } = require('../common/audit.service');
const { sendSuccess, sendError } = require('../utils/response');

// `mnemonic.service` pulls in `crypto.service`, which refuses to load without
// a valid ENCRYPTION_KEY. Requiring it at module scope would make MOUNTING
// the wallet router depend on encryption config being present — which broke
// two unrelated route tests that mount the router without it, and would make
// a misconfigured deployment fail at import rather than at the one endpoint
// that actually needs a key. Loaded on first use instead; `require` caches,
// so this costs one property lookup per call.
let cachedService = null;
const service = () => {
  if (!cachedService) cachedService = require('../wallet/mnemonic.service');
  return cachedService;
};

/** The channel the challenge is actually delivered over. Not SMS; see above. */
const CHALLENGE_CHANNEL = 'whatsapp';

/**
 * Service error code → HTTP status.
 *
 * `grant_not_found` is 404 and so is a grant that belongs to someone else, so
 * the API cannot be used to discover which grant ids exist. A rejected PIN or
 * code is 401 rather than 400: the request was well-formed, the credential was
 * not. Exhausted attempts and a used grant are 409, because the resource's
 * state — not the request — is what makes a retry pointless.
 */
const STATUS_BY_CODE = Object.freeze({
  wallet_not_found: 404,
  grant_not_found: 404,
  pin_rejected: 401,
  challenge_rejected: 401,
  export_not_authorized: 403,
  grant_expired: 410,
  grant_consumed: 409,
  challenge_attempts_exceeded: 429,
  invalid_mnemonic: 400,
  mnemonic_mismatch: 400,
  invalid_account_index: 400,
});

// The literals above must stay in step with the service's own codes. Asserted
// rather than trusted: `mnemonicExport.api.test.js` checks every
// EXPORT_ERROR_CODES value has an entry here, so adding a code to the service
// without mapping it fails a test instead of silently returning 500.
const statusForCode = (code) => STATUS_BY_CODE[code];

/**
 * Translate a service error into a response, or hand it on.
 *
 * Only errors carrying a known `EXPORT_ERROR_CODES` value are shaped here. An
 * unrecognised failure goes to `next` so the error middleware logs it and
 * returns a generic 500 — guessing a status for an unknown fault is how a
 * server ends up telling a client that a crash was their mistake.
 */
const respondToExportError = (res, next, error) => {
  const status = statusForCode(error?.code);
  if (!status) return next(error);

  const details = { code: error.code };
  // The PIN service's lockout hints are safe to pass on and let a client back
  // off correctly; they say nothing about the PIN itself.
  if (error.locked) details.locked = true;
  if (error.retryAfterMs) details.retryAfterMs = error.retryAfterMs;

  return sendError(res, error.message, status, details);
};

/**
 * The wallet this export is about.
 *
 * An explicit `walletId` is honoured — the service re-checks ownership — and
 * otherwise the caller's Stellar wallet is used, so the common case needs no
 * body at all. Ownership is filtered in the query rather than after it: a
 * wallet belonging to another user is simply not found.
 */
const resolveWalletId = async ({ userId, walletId, db }) => {
  if (walletId) return String(walletId);
  const wallet = await db.wallet.findFirst({
    where: { userId, chain: 'stellar' },
    orderBy: { createdAt: 'asc' },
  });
  return wallet?.id || null;
};

/**
 * Load a grant and prove it belongs to the caller.
 *
 * Returns `null` for a grant that is missing OR owned by someone else, and
 * the caller turns both into the same 404. The distinction is exactly what an
 * attacker would want to learn.
 */
const assertOwnedGrant = async ({ grantId, userId, db }) => {
  if (!grantId) return null;
  const grant = await db.mnemonicExportGrant.findUnique({ where: { id: String(grantId) } });
  if (!grant || grant.userId !== userId) return null;
  return grant;
};

/**
 * Deliver the challenge code out of band.
 *
 * Injected so tests never send anything and an SMS provider can replace it
 * without touching policy. Delivery failure is NOT swallowed: if the code
 * cannot reach the user, the request has failed, and reporting success would
 * leave them waiting for a message that is not coming.
 */
const deliverChallenge = async ({ phoneNumber, code }) => {
  await whatsapp.sendTextMessage(
    phoneNumber,
    `Your SendAm wallet export code is ${code}. It expires shortly. `
    + 'If you did not request a wallet export, do not share this code and contact support.',
  );
};

/**
 * POST /api/wallet/export/request — start an export and send the challenge.
 */
const requestExport = async (req, res, next) => {
  try {
    const userId = req.restUser.id;
    const walletId = await resolveWalletId({
      userId,
      walletId: req.body?.walletId,
      db: prisma,
    });
    if (!walletId) return sendError(res, 'Wallet not found for this user.', 404, {
      code: service().EXPORT_ERROR_CODES.WALLET_NOT_FOUND,
    });

    const grant = await service().requestExport({
      userId,
      walletId,
      prismaClient: prisma,
      sendChallenge: req.deliverChallenge || deliverChallenge,
    });

    return sendSuccess(res, {
      grantId: grant.id,
      status: grant.status,
      walletId: grant.walletId,
      challengeExpiresAt: grant.challengeExpiresAt,
      // Named explicitly so no caller has to assume this was an SMS.
      channel: CHALLENGE_CHANNEL,
      challengeDigits: service().CHALLENGE_DIGITS,
      maxAttempts: service().CHALLENGE_MAX_ATTEMPTS,
    }, 'Export challenge sent', 201);
  } catch (error) {
    return respondToExportError(res, next, error);
  }
};

/**
 * POST /api/wallet/export/verify — PIN plus the out-of-band code.
 *
 * Both factors go to the service together; neither is checked here, so there
 * is no partial-credit state in this process for a caller to exploit.
 */
const verifyExport = async (req, res, next) => {
  try {
    const userId = req.restUser.id;
    const { grantId, code, pin } = req.body || {};

    const owned = await assertOwnedGrant({ grantId, userId, db: prisma });
    if (!owned) return sendError(res, 'Export grant not found.', 404, {
      code: service().EXPORT_ERROR_CODES.GRANT_NOT_FOUND,
    });

    const authorized = await service().verifyExportChallenge({
      grantId: owned.id,
      code,
      pin,
      prismaClient: prisma,
    });

    return sendSuccess(res, {
      grantId: authorized.id,
      status: authorized.status,
      authorizedAt: authorized.authorizedAt,
    }, 'Export authorized');
  } catch (error) {
    return respondToExportError(res, next, error);
  }
};

/**
 * POST /api/wallet/export/claim — hand over the material, once.
 *
 * The service performs the single-use claim as a conditional update, so two
 * concurrent requests cannot both succeed; this handler adds the ownership
 * check the service does not make, and makes sure the response is not stored
 * anywhere on the way back.
 */
const claimExport = async (req, res, next) => {
  try {
    const userId = req.restUser.id;
    const { grantId } = req.body || {};

    const owned = await assertOwnedGrant({ grantId, userId, db: prisma });
    if (!owned) return sendError(res, 'Export grant not found.', 404, {
      code: service().EXPORT_ERROR_CODES.GRANT_NOT_FOUND,
    });

    const payload = await service().consumeExport({
      grantId: owned.id,
      prismaClient: prisma,
    });

    // This body carries key material. Keep it out of every cache between here
    // and the client.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Surrogate-Control', 'no-store');

    // The service already wrote `wallet.export.completed`. This line exists so
    // the HTTP boundary is visible in operational logs too, and it names only
    // the grant and the FORM of the export — never the phrase, the secret key
    // or the challenge code.
    logger.info(
      `Wallet export claimed over REST for grant ${owned.id} (format: ${payload.importFormat}).`,
    );

    return sendSuccess(res, payload, 'Export completed');
  } catch (error) {
    return respondToExportError(res, next, error);
  }
};

/**
 * POST /api/wallet/export/revoke — let a user cancel their own pending export.
 *
 * The counterpart to "if this was not you, contact support": a user who sees a
 * code they did not ask for can close the window immediately instead of
 * waiting it out. Only a grant that has not yet been used can be revoked, and
 * revoking is idempotent, so a double tap is not an error.
 */
const revokeExport = async (req, res, next) => {
  try {
    const userId = req.restUser.id;
    const { grantId } = req.body || {};

    const owned = await assertOwnedGrant({ grantId, userId, db: prisma });
    if (!owned) return sendError(res, 'Export grant not found.', 404, {
      code: service().EXPORT_ERROR_CODES.GRANT_NOT_FOUND,
    });

    if (owned.status === service().GRANT_STATUS.CONSUMED) {
      return sendError(res, 'This export has already been used.', 409, {
        code: service().EXPORT_ERROR_CODES.GRANT_CONSUMED,
      });
    }

    // Conditional, so revoking cannot race a claim into an inconsistent state:
    // whichever update the database applies first decides the outcome.
    const result = await prisma.mnemonicExportGrant.updateMany({
      where: { id: owned.id, userId, consumedAt: null },
      data: { status: service().GRANT_STATUS.REVOKED },
    });
    if (!result || result.count !== 1) {
      return sendError(res, 'This export has already been used.', 409, {
        code: service().EXPORT_ERROR_CODES.GRANT_CONSUMED,
      });
    }

    await writeAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'wallet.export.revoked',
      entityType: 'Wallet',
      entityId: owned.walletId,
      metadata: { grantId: owned.id, revokedAt: new Date().toISOString() },
    });

    return sendSuccess(res, {
      grantId: owned.id,
      status: service().GRANT_STATUS.REVOKED,
    }, 'Export revoked');
  } catch (error) {
    return respondToExportError(res, next, error);
  }
};

module.exports = {
  CHALLENGE_CHANNEL,
  STATUS_BY_CODE,
  statusForCode,
  deliverChallenge,
  resolveWalletId,
  assertOwnedGrant,
  requestExport,
  verifyExport,
  claimExport,
  revokeExport,
};

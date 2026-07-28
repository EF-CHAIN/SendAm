// Central startup check. crypto.service.js and adminAuth.service.js already
// throw at require-time for their own secrets, but that only fires once
// those specific modules happen to load, and it stops at the first problem
// found — an operator fixing ENCRYPTION_KEY only to hit JWT_SECRET on the
// next boot is a bad debugging loop. This runs once, explicitly, before the
// app starts accepting connections, and reports every violation at once.
// Circle's Testnet USDC issuer — must never be used on mainnet.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const validateEnv = (config) => {
  const problems = [];

  if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'hex').length !== 32) {
    problems.push('ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32');
  }

  if (!config.admin.jwtSecret || config.admin.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');
  }

  if (!config.admin.password) {
    problems.push('ADMIN_PASSWORD must be set.');
  }

  if (config.isProduction && !config.whatsapp.appSecret) {
    problems.push('WHATSAPP_APP_SECRET must be set in production — without it, inbound webhook signatures cannot be verified.');
  }

  if (!['meta', 'sim'].includes(config.messageTransport)) {
    problems.push(`MESSAGE_TRANSPORT must be either 'meta' or 'sim' (got '${config.messageTransport}').`);
  }

  // Mainnet safety: the testnet USDC issuer must never be used on mainnet.
  // This prevents accidental misconfiguration that could cause funds to be
  // sent to or received from an uncontrolled testnet issuer.
  if (config.stellar && config.stellar.isMainnet) {
    if (config.stellar.usdcIssuer === TESTNET_USDC_ISSUER) {
      problems.push(
        'STELLAR_USDC_ISSUER on mainnet must not be the Testnet issuer. '
        + 'Set it to Circle\'s mainnet issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
};

module.exports = { validateEnv };

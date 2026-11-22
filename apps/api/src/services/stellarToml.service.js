const fs = require('fs');
const toml = require('toml');
const { StellarSdk } = require('../config/stellar');
const config = require('../config/env');
const logger = require('../utils/logger');

const STELLAR_TOML_MAX_SIZE = StellarSdk.StellarToml?.STELLAR_TOML_MAX_SIZE || 102400;

// Fallback testnet signing key for local development when STELLAR_AUTH_SIGNING_KEY is not configured.
const DEFAULT_TESTNET_SIGNING_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * Resolve public signing key from configuration or environment.
 * If a secret seed (starts with S) is provided, derives the public G... key.
 * Never exposes secret keys in the TOML file.
 */
const resolveSigningKey = () => {
  const explicitKey = process.env.STELLAR_SIGNING_KEY || process.env.SIGNING_KEY;
  if (explicitKey && StellarSdk.StrKey.isValidEd25519PublicKey(explicitKey)) {
    return explicitKey;
  }

  const authKey = config.stellar?.auth?.signingKey || process.env.STELLAR_AUTH_SIGNING_KEY;
  if (authKey) {
    if (StellarSdk.StrKey.isValidEd25519PublicKey(authKey)) {
      return authKey;
    }
    if (StellarSdk.StrKey.isValidEd25519SecretSeed(authKey)) {
      try {
        return StellarSdk.Keypair.fromSecret(authKey).publicKey();
      } catch (err) {
        logger.warn('Failed to derive public key from STELLAR_AUTH_SIGNING_KEY', { error: err.message });
      }
    }
  }

  return DEFAULT_TESTNET_SIGNING_KEY;
};

/**
 * Resolve endpoint URLs dynamically based on environment or incoming request.
 */
const resolveEndpoints = (req = null) => {
  const homeDomain = config.stellar?.auth?.homeDomain || process.env.STELLAR_HOME_DOMAIN || 'sendam.app';
  const webAuthDomain = config.stellar?.auth?.webAuthDomain || process.env.STELLAR_WEB_AUTH_DOMAIN || `api.${homeDomain}`;

  let requestProtocol = 'https';
  let requestHost = webAuthDomain;

  if (req) {
    const forwardedProto = req.get('x-forwarded-proto');
    if (forwardedProto) {
      requestProtocol = forwardedProto.split(',')[0].trim();
    } else if (req.protocol) {
      requestProtocol = req.protocol;
    }
    const host = req.get('host');
    if (host && !host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
      requestHost = host;
    }
  }

  const defaultBaseUrl = `${requestProtocol}://${requestHost}`;

  const webAuthEndpoint = process.env.STELLAR_WEB_AUTH_ENDPOINT
    || `${defaultBaseUrl}/api/auth`;

  const federationServer = process.env.STELLAR_FEDERATION_SERVER
    || `${defaultBaseUrl}/api/federation`;

  const kycServer = process.env.STELLAR_KYC_SERVER
    || `${defaultBaseUrl}/api/compliance`;

  return {
    homeDomain,
    webAuthDomain,
    webAuthEndpoint,
    federationServer,
    kycServer,
    horizonUrl: config.stellar?.horizonUrl || 'https://horizon-testnet.stellar.org',
  };
};

/**
 * Build currency definitions compliant with SEP-1.
 */
const buildCurrencies = () => {
  const isMainnet = Boolean(config.stellar?.isMainnet);
  const usdcIssuer = config.stellar?.usdcIssuer
    || (isMainnet
      ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

  const currencies = [
    {
      code: 'USDC',
      issuer: usdcIssuer,
      display_decimals: 7,
      desc: 'USD Coin issued on Stellar',
      is_asset_anchored: true,
      anchor_asset_type: 'fiat',
      anchor_asset: 'USD',
      status: isMainnet ? 'live' : 'test',
    },
    {
      code: 'XLM',
      display_decimals: 7,
      desc: 'Lumen (native Stellar network token)',
      is_asset_anchored: false,
      status: 'live',
    },
  ];

  return currencies;
};

/**
 * Generate complete structured JavaScript data for stellar.toml.
 */
const getStellarTomlData = (options = {}) => {
  const req = options.req || null;
  const endpoints = resolveEndpoints(req);
  const signingKey = options.signingKey || resolveSigningKey();
  const networkPassphrase = options.networkPassphrase
    || config.stellar?.networkPassphrase
    || (config.stellar?.isMainnet
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015');

  const data = {
    VERSION: '2.0.0',
    NETWORK_PASSPHRASE: networkPassphrase,
    FEDERATION_SERVER: endpoints.federationServer,
    AUTH_SERVER: endpoints.webAuthEndpoint,
    WEB_AUTH_ENDPOINT: endpoints.webAuthEndpoint,
    SIGNING_KEY: signingKey,
    HORIZON_URL: endpoints.horizonUrl,
  };

  if (process.env.STELLAR_TRANSFER_SERVER) {
    data.TRANSFER_SERVER = process.env.STELLAR_TRANSFER_SERVER;
  }
  if (process.env.STELLAR_TRANSFER_SERVER_0024) {
    data.TRANSFER_SERVER_0024 = process.env.STELLAR_TRANSFER_SERVER_0024;
  }
  if (process.env.STELLAR_KYC_SERVER || endpoints.kycServer) {
    data.KYC_SERVER = process.env.STELLAR_KYC_SERVER || endpoints.kycServer;
  }
  if (process.env.STELLAR_DIRECT_PAYMENT_SERVER) {
    data.DIRECT_PAYMENT_SERVER = process.env.STELLAR_DIRECT_PAYMENT_SERVER;
  }
  if (process.env.STELLAR_ANCHOR_QUOTE_SERVER) {
    data.ANCHOR_QUOTE_SERVER = process.env.STELLAR_ANCHOR_QUOTE_SERVER;
  }

  data.DOCUMENTATION = {
    ORG_NAME: process.env.STELLAR_ORG_NAME || 'SendAm',
    ORG_DBA: process.env.STELLAR_ORG_DBA || 'SendAm',
    ORG_URL: process.env.STELLAR_ORG_URL || `https://${endpoints.homeDomain}`,
    ORG_LOGO: process.env.STELLAR_ORG_LOGO || `https://${endpoints.homeDomain}/logo-sent.svg`,
    ORG_DESCRIPTION: process.env.STELLAR_ORG_DESCRIPTION || 'WhatsApp-first Stellar remittance and payment bridge for Africa',
    ORG_OFFICIAL_EMAIL: process.env.STELLAR_ORG_OFFICIAL_EMAIL || 'support@sendam.app',
    ORG_SUPPORT_EMAIL: process.env.STELLAR_ORG_SUPPORT_EMAIL || 'support@sendam.app',
    ORG_GITHUB: process.env.STELLAR_ORG_GITHUB || 'https://github.com/EF-CHAIN/SendAm',
    ORG_TWITTER: process.env.STELLAR_ORG_TWITTER || '@SendAmApp',
  };

  data.PRINCIPALS = [
    {
      name: 'SendAm Operations',
      email: 'support@sendam.app',
      github: 'https://github.com/EF-CHAIN/SendAm',
    },
  ];

  data.CURRENCIES = options.currencies || buildCurrencies();

  return data;
};

/**
 * Escape a string for TOML format.
 */
const escapeTomlString = (str) => {
  if (str === null || str === undefined) return '""';
  return JSON.stringify(String(str));
};

/**
 * Format a key-value pair in TOML syntax.
 */
const formatValue = (val) => {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '0';
  if (typeof val === 'string') return escapeTomlString(val);
  return escapeTomlString(String(val));
};

/**
 * Serialize JavaScript data object into standard TOML string.
 */
const serializeToml = (data) => {
  const lines = [
    '# Stellar SEP-1 Discovery Configuration for SendAm',
    '# Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md',
    '',
  ];

  // Top-level key-values
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined && typeof value !== 'object') {
      lines.push(`${key} = ${formatValue(value)}`);
    }
  }

  // Sub-tables (like DOCUMENTATION)
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push('');
      lines.push(`[${key}]`);
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subVal !== null && subVal !== undefined) {
          lines.push(`${subKey} = ${formatValue(subVal)}`);
        }
      }
    }
  }

  // Arrays of tables (like PRINCIPALS, CURRENCIES)
  for (const [key, arr] of Object.entries(data)) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        lines.push('');
        lines.push(`[[${key}]]`);
        for (const [itemKey, itemVal] of Object.entries(item)) {
          if (itemVal !== null && itemVal !== undefined) {
            lines.push(`${itemKey} = ${formatValue(itemVal)}`);
          }
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
};

/**
 * Validate a TOML string or parsed object against Stellar TOML (SEP-1) specifications.
 */
const validateStellarToml = (input) => {
  const errors = [];
  const warnings = [];
  let parsed = null;

  if (typeof input === 'string') {
    const byteLength = Buffer.byteLength(input, 'utf8');
    if (byteLength > STELLAR_TOML_MAX_SIZE) {
      errors.push(`stellar.toml exceeds maximum allowed size of 100KB (${byteLength} bytes > ${STELLAR_TOML_MAX_SIZE} bytes)`);
    }

    try {
      parsed = toml.parse(input);
    } catch (parseError) {
      errors.push(`TOML syntax error: ${parseError.message}`);
      return {
        valid: false,
        errors,
        warnings,
        parsed: null,
      };
    }
  } else if (input && typeof input === 'object') {
    parsed = input;
  } else {
    errors.push('Input must be a valid TOML string or parsed object');
    return {
      valid: false,
      errors,
      warnings,
      parsed: null,
    };
  }

  // 1. NETWORK_PASSPHRASE check
  if (!parsed.NETWORK_PASSPHRASE || typeof parsed.NETWORK_PASSPHRASE !== 'string' || !parsed.NETWORK_PASSPHRASE.trim()) {
    errors.push('Missing required field: NETWORK_PASSPHRASE');
  }

  // 2. SIGNING_KEY check
  if (!parsed.SIGNING_KEY || typeof parsed.SIGNING_KEY !== 'string') {
    errors.push('Missing required field: SIGNING_KEY');
  } else if (!StellarSdk.StrKey.isValidEd25519PublicKey(parsed.SIGNING_KEY)) {
    errors.push(`SIGNING_KEY must be a valid Stellar Ed25519 public key (starts with G): got "${parsed.SIGNING_KEY}"`);
  }

  // 3. WEB_AUTH_ENDPOINT check
  const webAuth = parsed.WEB_AUTH_ENDPOINT || parsed.AUTH_SERVER;
  if (!webAuth || typeof webAuth !== 'string') {
    errors.push('Missing required field: WEB_AUTH_ENDPOINT');
  } else {
    try {
      const url = new URL(webAuth);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.push(`WEB_AUTH_ENDPOINT must use HTTP or HTTPS protocol: got "${webAuth}"`);
      }
      if (config.isProduction && url.protocol !== 'https:') {
        warnings.push('WEB_AUTH_ENDPOINT should use HTTPS in production');
      }
    } catch (_err) {
      errors.push(`WEB_AUTH_ENDPOINT must be a valid URL: got "${webAuth}"`);
    }
  }

  // 4. CURRENCIES check
  if (!parsed.CURRENCIES || !Array.isArray(parsed.CURRENCIES) || parsed.CURRENCIES.length === 0) {
    errors.push('Missing required section: [[CURRENCIES]] must declare at least one currency');
  } else {
    parsed.CURRENCIES.forEach((currency, index) => {
      if (!currency.code || typeof currency.code !== 'string') {
        errors.push(`CURRENCIES[${index}] missing required "code" field`);
      } else if (!/^[a-zA-Z0-9]{1,12}$/.test(currency.code)) {
        errors.push(`CURRENCIES[${index}] "code" must be 1-12 alphanumeric characters: got "${currency.code}"`);
      }

      if (currency.code && currency.code.toUpperCase() !== 'XLM') {
        if (!currency.issuer) {
          errors.push(`CURRENCIES[${index}] for asset "${currency.code}" must declare an "issuer"`);
        } else if (!StellarSdk.StrKey.isValidEd25519PublicKey(currency.issuer)) {
          errors.push(`CURRENCIES[${index}] issuer must be a valid Stellar public key: got "${currency.issuer}"`);
        }
      }

      if (currency.status && !['live', 'dead', 'test', 'private'].includes(currency.status)) {
        warnings.push(`CURRENCIES[${index}] status should be one of live, dead, test, private: got "${currency.status}"`);
      }

      if (currency.display_decimals !== undefined && (!Number.isInteger(currency.display_decimals) || currency.display_decimals < 0)) {
        errors.push(`CURRENCIES[${index}] display_decimals must be a non-negative integer`);
      }
    });
  }

  // Optional URL checks
  const urlFields = ['FEDERATION_SERVER', 'HORIZON_URL', 'TRANSFER_SERVER', 'TRANSFER_SERVER_0024', 'KYC_SERVER'];
  for (const field of urlFields) {
    if (parsed[field]) {
      try {
        new URL(parsed[field]);
      } catch (_err) {
        errors.push(`${field} must be a valid URL: got "${parsed[field]}"`);
      }
    }
  }

  const currenciesList = Array.isArray(parsed.CURRENCIES) ? parsed.CURRENCIES.map((c) => c.code) : [];

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed,
    summary: {
      networkPassphrase: parsed.NETWORK_PASSPHRASE || null,
      signingKey: parsed.SIGNING_KEY || null,
      webAuthEndpoint: webAuth || null,
      currencies: currenciesList,
      currencyCount: currenciesList.length,
      sizeBytes: typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : undefined,
    },
  };
};

/**
 * Get the generated or static stellar.toml content.
 */
const getStellarTomlContent = (options = {}) => {
  // If an explicit template file path is configured, check if it exists
  const explicitPath = options.filePath || process.env.STELLAR_TOML_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    try {
      return fs.readFileSync(explicitPath, 'utf8');
    } catch (err) {
      logger.error('Failed to read configured stellar.toml file, falling back to dynamic generation', { error: err.message });
    }
  }

  const data = getStellarTomlData(options);
  return serializeToml(data);
};

module.exports = {
  getStellarTomlData,
  serializeToml,
  validateStellarToml,
  getStellarTomlContent,
  resolveSigningKey,
  resolveEndpoints,
  buildCurrencies,
  STELLAR_TOML_MAX_SIZE,
};

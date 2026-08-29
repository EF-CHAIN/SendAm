const crypto = require('crypto');
const config = require('../config/env');

const PIN_PREFIX = 'pin';
const LEGACY_PIN_ALGORITHM = 'hmac-sha256';

const normalizePin = (pin) => {
  const value = String(pin ?? '').trim();
  if (!/^\d{4,6}$/.test(value)) {
    throw new Error('PIN must be 4 to 6 digits.');
  }
  return value;
};

const getSupportedVersions = () => {
  const configured = Array.isArray(config.compliance.pinPepperVersions)
    ? config.compliance.pinPepperVersions
    : [config.compliance.pinPepperVersion || 'v1'];
  const current = config.compliance.pinPepperVersion || 'v1';
  const versions = [...configured, current];
  return [...new Set(versions.filter(Boolean))];
};

const getPepperByVersion = (version) => {
  if (!version) return config.compliance.pinPepper;
  if (config.compliance.pinPepperByVersion && config.compliance.pinPepperByVersion[version]) {
    return config.compliance.pinPepperByVersion[version];
  }
  return config.compliance.pinPepper;
};

const parseHash = (pinHash) => {
  if (!pinHash || typeof pinHash !== 'string') return null;
  if (!pinHash.startsWith(`${PIN_PREFIX}$`)) return null;

  const parts = pinHash.split('$');
  if (parts.length < 8) return null;

  const [, version, algorithm, n, r, p, salt, hash] = parts;
  if (!version || !algorithm || !n || !r || !p || !salt || !hash) {
    return null;
  }

  return {
    version,
    algorithm,
    n: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt,
    hash,
  };
};

const hashPin = (pin, options = {}) => {
  const normalizedPin = normalizePin(pin);
  const version = options.version || config.compliance.pinPepperVersion || 'v1';
  const pepper = options.pepper || getPepperByVersion(version);
  const salt = options.salt || crypto.randomBytes(config.compliance.pinHash.saltLength).toString('hex');
  const n = options.n ?? config.compliance.pinHash.n;
  const r = options.r ?? config.compliance.pinHash.r;
  const p = options.p ?? config.compliance.pinHash.p;
  const keyLength = options.keyLength ?? config.compliance.pinHash.keyLength;
  const maxMem = options.maxMem ?? config.compliance.pinHash.maxMem;

  const derived = crypto.scryptSync(normalizedPin, `${version}:${salt}:${pepper}`, keyLength, {
    N: n,
    r,
    p,
    maxmem: maxMem,
  });

  return `${PIN_PREFIX}$${version}$scrypt$${n}$${r}$${p}$${salt}$${derived.toString('hex')}`;
};

const safeTimingCompare = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch (_error) {
    return false;
  }
};

const verifyLegacyPin = (pin, pinHash) => {
  if (!pinHash || typeof pinHash !== 'string') return false;
  for (const version of getSupportedVersions()) {
    const pepper = getPepperByVersion(version);
    const expected = crypto.createHmac('sha256', pepper).update(String(pin ?? '')).digest('hex');
    if (safeTimingCompare(expected, pinHash)) {
      return true;
    }
  }
  return false;
};

const verifyPin = (pin, pinHash) => {
  if (!pinHash || typeof pinHash !== 'string') return false;

  const parsed = parseHash(pinHash);
  if (!parsed) {
    return verifyLegacyPin(pin, pinHash);
  }

  if (parsed.algorithm !== 'scrypt') return false;

  const version = parsed.version;
  const pepper = getPepperByVersion(version);
  const expected = crypto.scryptSync(normalizePin(pin), `${version}:${parsed.salt}:${pepper}`, config.compliance.pinHash.keyLength, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: config.compliance.pinHash.maxMem,
  }).toString('hex');

  return safeTimingCompare(expected, parsed.hash);
};

const verifyAndUpgradePin = (pin, pinHash) => {
  if (!pinHash) return { valid: false, upgraded: false, hash: null };

  const parsed = parseHash(pinHash);
  if (!parsed) {
    const valid = verifyLegacyPin(pin, pinHash);
    if (!valid) return { valid: false, upgraded: false, hash: null };
    const upgraded = hashPin(pin, { version: config.compliance.pinPepperVersion || 'v1' });
    return { valid: true, upgraded: true, hash: upgraded };
  }

  const valid = verifyPin(pin, pinHash);
  if (!valid) return { valid: false, upgraded: false, hash: null };

  const currentVersion = config.compliance.pinPepperVersion || 'v1';
  if (parsed.version === currentVersion) {
    return { valid: true, upgraded: false, hash: pinHash };
  }

  const upgraded = hashPin(pin, { version: currentVersion });
  return { valid: true, upgraded: true, hash: upgraded };
};

module.exports = {
  hashPin,
  verifyPin,
  verifyAndUpgradePin,
  LEGACY_PIN_ALGORITHM,
};

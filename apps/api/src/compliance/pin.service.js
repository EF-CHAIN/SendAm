const crypto = require('crypto');
const config = require('../config/env');

const hashPin = (pin) => {
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4 to 6 digits.');
  const pepper = config.compliance.pinPepper || config.admin.jwtSecret || 'development-only-pin-pepper';
  return crypto.createHmac('sha256', pepper).update(String(pin)).digest('hex');
};

const verifyPin = (pin, pinHash) => {
  if (!pinHash) return false;
  const expected = hashPin(pin);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(pinHash));
};

module.exports = {
  hashPin,
  verifyPin,
};

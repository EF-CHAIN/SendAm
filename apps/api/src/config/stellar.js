const StellarSdk = require('@stellar/stellar-sdk');
const config = require('./env');

const server = new StellarSdk.Horizon.Server(config.stellar.horizonUrl);

module.exports = {
  server,
  StellarSdk
};

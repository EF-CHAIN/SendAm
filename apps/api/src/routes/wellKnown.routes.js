const express = require('express');
const { getStellarTomlContent } = require('../services/stellarToml.service');

const router = express.Router();

const applyCorsAndHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Origin, Accept, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
};

const handleStellarToml = (req, res) => {
  applyCorsAndHeaders(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');

  const toml = getStellarTomlContent({ req });
  return res.status(200).send(toml);
};

const handleOptions = (_req, res) => {
  applyCorsAndHeaders(res);
  return res.status(204).end();
};

// SEP-1 standard discovery path
router.options('/.well-known/stellar.toml', handleOptions);
router.get('/.well-known/stellar.toml', handleStellarToml);

// Canonical fallback root path
router.options('/stellar.toml', handleOptions);
router.get('/stellar.toml', handleStellarToml);

module.exports = router;

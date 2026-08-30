const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-secrets.env');

describe('secret-scan fixture patterns', () => {
  let content;

  it('fixture file exists', () => {
    assert.ok(fs.existsSync(FIXTURE), `fixture not found: ${FIXTURE}`);
    content = fs.readFileSync(FIXTURE, 'utf8');
  });

  it('contains a Stellar secret key pattern', () => {
    const stellarKeyRe = /\bS[A-Z2-7]{55}\b/;
    assert.match(content, stellarKeyRe, 'fixture should contain a Stellar secret key');
  });

  it('contains a database URL with embedded password', () => {
    const dbUrlRe = /postgresql:\/\/[^:\s]+:[^@\s]+@/;
    assert.match(content, dbUrlRe, 'fixture should contain a database URL with password');
  });

  it('contains a generic API key assignment', () => {
    const apiKeyRe = /API_KEY\s*=\s*["']?[A-Za-z0-9+/=_\-]{20,}/;
    assert.match(content, apiKeyRe, 'fixture should contain a generic API key');
  });

  it('contains a JWT secret assignment', () => {
    const jwtRe = /JWT_SECRET\s*=\s*["']?[A-Za-z0-9+/=_\-]{20,}/;
    assert.match(content, jwtRe, 'fixture should contain a JWT secret');
  });

  it('contains a Redis URL with password', () => {
    const redisRe = /redis:\/\/:[^@\s]+@/;
    assert.match(content, redisRe, 'fixture should contain a Redis URL with password');
  });

  it('contains a hex encryption key', () => {
    const encKeyRe = /ENCRYPTION_KEY\s*=\s*[0-9a-fA-F]{32,}/;
    assert.match(content, encKeyRe, 'fixture should contain a hex encryption key');
  });
});

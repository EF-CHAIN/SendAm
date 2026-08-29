'use strict';

/**
 * Target resolution and the production guard.
 *
 * A load tool that can be pointed anywhere is one typo away from a
 * self-inflicted outage, so the default target is localhost and anything else
 * has to be unlocked explicitly. This is the "load tools never target
 * production by default" acceptance criterion, enforced in code rather than
 * left to documentation.
 */

const DEFAULT_TARGET = 'http://127.0.0.1:3002';

// `URL.hostname` keeps the brackets on an IPv6 literal, so the loopback address
// has to be listed in its bracketed form to ever match.
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
  'host.docker.internal',
]);

const isLocalTarget = (url) => LOCAL_HOSTNAMES.has(url.hostname);

class TargetRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetRefused';
  }
}

/**
 * @param {object} options
 * @param {string} [options.target] explicit --target, else LOAD_TARGET, else localhost.
 * @param {object} [options.env] process.env, injectable for tests.
 * @returns {{url: URL, isLocal: boolean}}
 * @throws {TargetRefused} when a non-local target is requested without opt-in.
 */
const resolveTarget = ({ target, env = process.env } = {}) => {
  const raw = target || env.LOAD_TARGET || DEFAULT_TARGET;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetRefused(`Target "${raw}" is not a valid URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TargetRefused(`Target "${raw}" must use http or https.`);
  }

  const local = isLocalTarget(url);

  // Two independent locks, because they fail differently. NODE_ENV=production
  // means *this process* is configured as production and should never generate
  // load at all. A remote host means we might be pointed at someone else's
  // environment even if our own NODE_ENV looks harmless.
  if (env.NODE_ENV === 'production' && env.LOAD_ALLOW_PRODUCTION !== 'true') {
    throw new TargetRefused(
      'Refusing to generate load with NODE_ENV=production. '
      + 'This guard exists so a load run cannot be started against production by accident. '
      + 'Set LOAD_ALLOW_PRODUCTION=true only for a deliberate, scheduled capacity test.',
    );
  }

  if (!local && env.LOAD_ALLOW_REMOTE !== 'true') {
    throw new TargetRefused(
      `Refusing to target non-local host "${url.hostname}". `
      + 'Run against a local or isolated environment, or set LOAD_ALLOW_REMOTE=true '
      + 'if you are certain the target is a staging environment you own.',
    );
  }

  return { url, isLocal: local };
};

module.exports = { resolveTarget, isLocalTarget, TargetRefused, DEFAULT_TARGET, LOCAL_HOSTNAMES };

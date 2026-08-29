'use strict';

const crypto = require('node:crypto');

/**
 * Minimal HTTP client for the harness, on the platform `fetch`.
 *
 * Deliberately dependency-free: a load tool that needs its own npm install is
 * a load tool nobody runs, and adding a client library here would put it in
 * the API's production dependency tree for the sake of tooling.
 */

/**
 * Sign a webhook body exactly the way Meta does, so the harness exercises the
 * real signature-verification path rather than the unsigned development
 * bypass. Without this, a load run would measure a middleware that production
 * never takes.
 */
const signBody = (rawBody, appSecret) =>
  'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

/**
 * @returns {{ok: boolean, statusCode: number|null, reason?: string, body?: string}}
 */
const send = async ({ url, method = 'GET', body, headers = {}, appSecret, timeoutMs = 15000, acceptStatus }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestHeaders = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    requestHeaders['content-type'] = requestHeaders['content-type'] || 'application/json';
    if (appSecret) requestHeaders['X-Hub-Signature-256'] = signBody(payload, appSecret);
  }

  try {
    const response = await fetch(url, {
      method,
      body: payload,
      headers: requestHeaders,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    const ok = acceptStatus ? acceptStatus(response.status) : response.ok;
    return {
      ok,
      statusCode: response.status,
      body: text,
      reason: ok ? undefined : `http_${response.status}`,
    };
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : (error.cause?.code || error.code || 'network_error');
    return { ok: false, statusCode: null, reason };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { send, signBody };

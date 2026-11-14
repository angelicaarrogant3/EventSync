const crypto = require('crypto');
const config = require('../config');

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

function generateSignature(registrationId, eventId, tokenVersion = 1, secret = config.qrHmacSecret) {
  const payload = tokenVersion > 1
    ? `${registrationId}:${eventId}:v${tokenVersion}`
    : `${registrationId}:${eventId}`;
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

/**
 * Generates a signed QR token string:
 * v1: base64url(registrationId + "." + eventId + "." + HMAC_SHA256)
 * vN (N > 1): base64url(registrationId + "." + eventId + ".v" + N + "." + HMAC_SHA256)
 */
function generateSignedQrToken(registrationId, eventId, tokenVersion = 1) {
  const ver = Math.max(1, parseInt(tokenVersion, 10) || 1);
  const signature = generateSignature(registrationId, eventId, ver);
  const rawPayload = ver > 1
    ? `${registrationId}.${eventId}.v${ver}.${signature}`
    : `${registrationId}.${eventId}.${signature}`;
  return base64UrlEncode(rawPayload);
}

/**
 * Verifies the integrity of a signed QR token.
 * Returns { valid: boolean, registrationId, eventId, tokenVersion, reason }
 */
function verifySignedQrToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'EMPTY_OR_INVALID_FORMAT' };
  }

  try {
    const decoded = base64UrlDecode(token);
    const parts = decoded.split('.');

    let registrationId;
    let eventId;
    let tokenVersion = 1;
    let signature;

    if (parts.length === 3) {
      [registrationId, eventId, signature] = parts;
    } else if (parts.length === 4 && /^v\d+$/.test(parts[2])) {
      [registrationId, eventId] = parts;
      tokenVersion = parseInt(parts[2].slice(1), 10);
      signature = parts[3];
    } else {
      return { valid: false, reason: 'MALFORMED_TOKEN_STRUCTURE' };
    }

    if (!registrationId || !eventId || !signature || !Number.isInteger(tokenVersion) || tokenVersion < 1) {
      return { valid: false, reason: 'MISSING_TOKEN_COMPONENTS' };
    }

    const expectedSignature = generateSignature(registrationId, eventId, tokenVersion);
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    return {
      valid: true,
      registrationId,
      eventId,
      tokenVersion
    };
  } catch (err) {
    return {
      valid: false,
      reason: 'DECODE_FAILURE: ' + err.message
    };
  }
}

function provisionalQrFormatCheck(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = base64UrlDecode(token);
    const parts = decoded.split('.');
    if (parts.length === 3) {
      return parts[0].length > 0 && parts[1].length > 0 && parts[2].length === 64;
    }
    if (parts.length === 4 && /^v\d+$/.test(parts[2])) {
      return parts[0].length > 0 && parts[1].length > 0 && parts[3].length === 64;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  generateSignedQrToken,
  verifySignedQrToken,
  provisionalQrFormatCheck,
  base64UrlEncode,
  base64UrlDecode
};

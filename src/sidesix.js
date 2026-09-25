import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const launchNonces = new Map();
const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const safeInt = (value, fallback = null) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback;

function sideSixError(code, message, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function equalHex(expectedHex, suppliedHex) {
  if (typeof suppliedHex !== 'string' || !/^[a-f0-9]+$/i.test(suppliedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const supplied = Buffer.from(suppliedHex, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function createSideSixClient(env = process.env) {
  const enabled = truthy(env.SIDESIX_ENABLED);
  const baseUrl = String(env.SIDESIX_BASE_URL || 'https://sidesix.xyz').replace(/\/+$/, '');
  const origin = new URL(baseUrl).origin;
  const secret = String(env.SIDESIX_SHARED_SECRET || '');
  const packId = safeInt(env.SIDESIX_PACK_ID);
  const currency = String(env.SIDESIX_CURRENCY || 'MYR').toUpperCase();
  const skewSeconds = safeInt(env.SIDESIX_HMAC_SKEW_SECONDS, 300);
  const timeoutMs = Math.max(1000, safeInt(env.SIDESIX_TIMEOUT_MS, 8000));

  if (enabled && secret.length < 16) throw new Error('SIDESIX_ENABLED requires SIDESIX_SHARED_SECRET');
  if (enabled && (!Number.isSafeInteger(packId) || packId <= 0)) throw new Error('SIDESIX_ENABLED requires SIDESIX_PACK_ID');

  function verifyLaunch(payload) {
    if (!enabled) return null;
    const userId = String(payload?.userId ?? '');
    const userName = String(payload?.userName ?? '');
    const ts = String(payload?.ts ?? '');
    const nonce = String(payload?.nonce ?? '');
    const sig = String(payload?.sig ?? '');
    if (!/^[0-9]+$/.test(userId) || !userName || userName.length > 64 || !/^[0-9]+$/.test(ts) || !/^[A-Za-z0-9-]+$/.test(nonce) || nonce.length > 100 || !/^[a-f0-9]{64}$/i.test(sig)) {
      throw sideSixError('SIDESIX_LAUNCH_INVALID', 'Invalid SideSix launch payload', 401);
    }

    const now = Math.floor(Date.now() / 1000);
    const launchTs = Number(ts);
    if (!Number.isSafeInteger(launchTs) || Math.abs(now - launchTs) > skewSeconds) {
      throw sideSixError('SIDESIX_LAUNCH_EXPIRED', 'SideSix launch link expired', 401);
    }
    for (const [key, expiry] of launchNonces) if (expiry <= now) launchNonces.delete(key);
    if (launchNonces.has(nonce)) throw sideSixError('SIDESIX_LAUNCH_REPLAYED', 'SideSix launch link already used', 401);

    const optional = {};
    for (const key of ['avatarUrl', 'locale', 'returnUrl']) {
      const value = payload?.[key];
      if (value !== undefined && value !== null && String(value) !== '') optional[key] = String(value);
    }
    if (optional.returnUrl) {
      let url;
      try { url = new URL(optional.returnUrl); } catch { throw sideSixError('SIDESIX_RETURN_URL_INVALID', 'Invalid SideSix return URL', 401); }
      if (url.origin !== origin) throw sideSixError('SIDESIX_RETURN_URL_INVALID', 'Untrusted SideSix return URL', 401);
    }

    const baseString = [
      ['userId', userId], ['userName', userName], ['ts', ts], ['nonce', nonce],
      ...Object.keys(optional).sort().map((key) => [key, optional[key]]),
    ].map(([key, value]) => `${key}=${value}`).join('&');
    const expected = createHmac('sha256', secret).update(baseString).digest('hex');
    if (!equalHex(expected, sig)) throw sideSixError('SIDESIX_LAUNCH_SIGNATURE_INVALID', 'Invalid SideSix launch signature', 401);

    launchNonces.set(nonce, now + skewSeconds * 2);
    return Object.freeze({
      userId,
      userName,
      returnUrl: optional.returnUrl || null,
      avatarUrl: optional.avatarUrl || null,
      locale: optional.locale || null,
    });
  }

  async function post(route, body) {
    if (!enabled) throw sideSixError('SIDESIX_DISABLED', 'SideSix wallet integration is disabled');
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${raw}`).digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/api/luxbox/play/${route}`, {
        method: 'POST',
        signal: controller.signal,
        body: raw,
        headers: {
          'Content-Type': 'application/json',
          'X-Luxbox-Timestamp': timestamp,
          'X-Luxbox-Nonce': nonce,
          'X-Luxbox-Signature': signature,
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const map = { 401: 'SIDESIX_AUTH_FAILED', 422: 'SIDESIX_WALLET_REJECTED', 429: 'SIDESIX_RATE_LIMITED', 503: 'SIDESIX_NOT_CONFIGURED' };
        throw sideSixError(map[response.status] || 'SIDESIX_WALLET_ERROR', payload?.message || `SideSix wallet HTTP ${response.status}`, response.status >= 500 ? 503 : response.status);
      }
      if (!payload || typeof payload !== 'object') throw sideSixError('SIDESIX_INVALID_RESPONSE', 'Invalid SideSix response');
      return payload;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') throw sideSixError('SIDESIX_TIMEOUT', 'SideSix wallet request timed out');
      throw sideSixError('SIDESIX_UNAVAILABLE', 'Unable to reach SideSix');
    } finally {
      clearTimeout(timer);
    }
  }

  const requestId = (...parts) => createHash('sha256').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');

  async function authorize({ userId, playCost, requestId: id }) {
    const payload = await post('authorize', {
      userId: String(userId),
      packId,
      playCost: Number(playCost).toFixed(2),
      playCount: 1,
      currency,
      requestId: id,
    });
    if (payload.status === 'insufficient') throw sideSixError('INSUFFICIENT_BALANCE', payload.message || 'Low SideSix balance', 409);
    if (payload.status !== 'sufficient' || !payload.transactionId) throw sideSixError('SIDESIX_AUTHORIZE_INVALID', 'SideSix did not authorize the wager');
    return payload;
  }

  async function settle({ userId, wonPrizeValue, authorizeTransactionId, requestId: id, playId = 1 }) {
    const payload = await post('settle', {
      userId: String(userId),
      packId,
      playId,
      wonPrizeValue: Number(wonPrizeValue).toFixed(2),
      authorizeTransactionId: String(authorizeTransactionId),
      requestId: id,
    });
    if (payload.status !== 'ok') throw sideSixError('SIDESIX_SETTLE_INVALID', 'SideSix did not confirm settlement');
    return payload;
  }

  async function refund({ userId, authorizeTransactionId, requestId: id, reason = 'game_failed' }) {
    const payload = await post('refund', {
      userId: String(userId),
      packId,
      authorizeTransactionId: String(authorizeTransactionId),
      requestId: id,
      reason: String(reason).slice(0, 64),
    });
    if (payload.status !== 'ok') throw sideSixError('SIDESIX_REFUND_INVALID', 'SideSix did not confirm refund');
    return payload;
  }

  return Object.freeze({
    configuration: Object.freeze({ enabled, baseUrl, origin, packId, currency, skewSeconds }),
    verifyLaunch,
    authorize,
    settle,
    refund,
    requestId,
  });
}

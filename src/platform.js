import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://gamingplatform-be.onrender.com';
const DEFAULT_API_PREFIX = '/api/v1';

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizePrefix(value) {
  const raw = String(value || DEFAULT_API_PREFIX).trim();
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '');
}

function platformError(code, message, status = 503, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  if (details !== undefined) error.details = details;
  return error;
}

function walletAmount(value, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw platformError('PLATFORM_WALLET_AMOUNT_INVALID', 'Platform wallet amounts must be positive whole coins', 400);
  }
  return number;
}

export function createPlatformClient(env = process.env) {
  const enabled = truthy(env.PLATFORM_ENABLED);
  const baseUrl = String(env.PLATFORM_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const apiPrefix = normalizePrefix(env.PLATFORM_API_PREFIX);
  const gameKey = String(env.PLATFORM_GAME_KEY || '').trim();
  const timeoutMs = Math.max(1000, Number.parseInt(env.PLATFORM_TIMEOUT_MS || '8000', 10) || 8000);

  if (enabled && (!gameKey.startsWith('gsk_') || gameKey.length < 30)) {
    throw new Error('PLATFORM_ENABLED requires a valid PLATFORM_GAME_KEY');
  }

  async function request(method, path, body = undefined) {
    if (!enabled) throw platformError('PLATFORM_NOT_CONFIGURED', 'Platform integration is disabled', 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${apiPrefix}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-Game-Key': gameKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) {
        const code = payload?.error?.code || `PLATFORM_HTTP_${response.status}`;
        const message = payload?.error?.message || `Platform HTTP ${response.status}`;
        throw platformError(code, message, response.status >= 500 ? 503 : response.status, payload?.error?.details);
      }
      if (!payload || payload.success !== true || payload.data === undefined) {
        throw platformError('PLATFORM_INVALID_RESPONSE', 'Platform returned an invalid response', 503);
      }
      return payload.data;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') throw platformError('PLATFORM_TIMEOUT', 'Platform request timed out', 503);
      throw platformError('PLATFORM_UNAVAILABLE', 'Unable to reach Platform wallet service', 503);
    } finally {
      clearTimeout(timer);
    }
  }

  const requestId = (...parts) => createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('|'))
    .digest('hex');

  async function consumeLaunch({ launchToken, exchangeId = randomUUID() }) {
    if (typeof launchToken !== 'string' || launchToken.length < 80) {
      throw platformError('INVALID_GAME_LAUNCH', 'A valid Platform launch token is required', 401);
    }
    const data = await request('POST', '/internal/game-launch/consume', { launchToken, exchangeId });
    if (!data?.user?.publicId || !data?.launch?.launchId || !data?.wallet?.currency) {
      throw platformError('PLATFORM_LAUNCH_INVALID_RESPONSE', 'Platform launch response is incomplete', 503);
    }
    return data;
  }

  const getBalance = (userId) => request('GET', `/internal/wallet/users/${encodeURIComponent(userId)}`);
  const reserve = ({ userId, matchId, amount, currency, idempotencyKey, metadata = {} }) => request('POST', '/internal/wallet/reserve', {
    idempotencyKey, userId: String(userId), matchId: String(matchId), amount: walletAmount(amount),
    ...(currency ? { currency: String(currency).toUpperCase() } : {}), metadata,
  });
  const capture = ({ userId, matchId, holdId, idempotencyKey, metadata = {} }) => request('POST', '/internal/wallet/capture', {
    idempotencyKey, holdId: String(holdId), userId: String(userId), matchId: String(matchId), metadata,
  });
  const release = ({ userId, matchId, holdId, idempotencyKey, metadata = {} }) => request('POST', '/internal/wallet/release', {
    idempotencyKey, holdId: String(holdId), userId: String(userId), matchId: String(matchId), metadata,
  });
  const payout = ({ userId, matchId, amount, currency, idempotencyKey, reason = 'Game payout', metadata = {} }) => request('POST', '/internal/wallet/payout', {
    idempotencyKey, userId: String(userId), matchId: String(matchId), amount: walletAmount(amount),
    ...(currency ? { currency: String(currency).toUpperCase() } : {}), reason, metadata,
  });
  const refund = ({ userId, matchId, holdId, amount, idempotencyKey, reason = 'Game refund', metadata = {} }) => request('POST', '/internal/wallet/refund', {
    idempotencyKey, holdId: String(holdId), userId: String(userId), matchId: String(matchId),
    ...(amount === undefined ? {} : { amount: walletAmount(amount) }), reason, metadata,
  });

  return Object.freeze({
    configuration: Object.freeze({ enabled, baseUrl, apiPrefix, timeoutMs }),
    consumeLaunch, getBalance, reserve, capture, release, payout, refund, requestId,
  });
}

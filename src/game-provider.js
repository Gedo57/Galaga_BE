import {createExhibitionGameBridge} from './exhibition-demo-bridge.js';
import {createProductionGameWalletBridge} from './production-provider-wallet.js';
const production=createProductionGameWalletBridge({gameId:'galaga'});
const demo=createExhibitionGameBridge('galaga');
import { createHash } from 'node:crypto';

const GAME_ID = 'galaga';
const enabled = String(process.env.GAME_PROVIDER_GALAGA_ENABLED || 'false').trim().toLowerCase() === 'true';
const baseUrl = String(process.env.GAME_PROVIDER_API_URL || '').trim().replace(/\/+$/, '');
const qaMode=String(process.env.GAME_PROVIDER_GALAGA_QA_MODE || 'false').trim().toLowerCase()==='true';
const preprodQaOrigin='https://g-provider-preproduction-sso-free.onrender.com';
const key = String(process.env.GAME_PROVIDER_GALAGA_ADAPTER_KEY || '').trim();
const credentials = /^[A-Za-z0-9_-]{32,256}$/;
const identifier = /^[A-Za-z0-9_.:-]{8,128}$/;

function issue(code, status = 503) {
  const error = new Error(code);
  error.code = code;
  error.status = error.statusCode = status;
  return error;
}
function requireConfigured() {
  if (!enabled) throw issue('GAME_PROVIDER_DISABLED');
  const devLocal = process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl);
  if (!/^https:\/\//.test(baseUrl) && !devLocal) throw issue('GAME_PROVIDER_URL_INVALID');
  if (!credentials.test(key)) throw issue('GAME_PROVIDER_ADAPTER_KEY_INVALID');
  // QA is fake-credit only and can never be silently pointed at a real casino wallet.
  if (qaMode && baseUrl!==preprodQaOrigin) throw issue('GAME_PROVIDER_QA_ORIGIN_INVALID');
  if (qaMode && !enabled) throw issue('GAME_PROVIDER_QA_DISABLED');
}
async function post(path, body) {
  requireConfigured();
  let response, payload;
  try {
    response = await fetch(`${baseUrl}/${qaMode?'api/v1/preprod/galaga':'api/v1'}/${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Game-Adapter-Key': key },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (raw.length > 16384) throw issue('GAME_PROVIDER_INVALID_RESPONSE');
    payload = JSON.parse(raw);
  } catch (error) {
    if (error?.code?.startsWith('GAME_PROVIDER_')) throw error;
    throw issue('GAME_PROVIDER_UNAVAILABLE');
  }
  if (!response.ok || payload?.ok !== true || !payload?.data) {
    throw issue(String(payload?.error?.code || 'GAME_PROVIDER_REQUEST_FAILED'), response.status === 202 ? 503 : response.status);
  }
  return payload.data;
}
function validateWallet(wallet) {
  if (wallet?.provider !== 'PROVIDER' || !identifier.test(wallet.launchId || '') ||
    !/^[A-Z0-9]{3,8}$/.test(wallet.currency || '') ||
    !Number.isInteger(wallet.walletDecimals) || wallet.walletDecimals < 0 || wallet.walletDecimals > 4) {
    throw issue('GAME_PROVIDER_IDENTITY_INVALID', 401);
  }
  return wallet;
}
function amountMinor(value, decimals) {
  const scaled = Number(value) * (10 ** decimals);
  const amount = Math.round(scaled);
  if (!Number.isSafeInteger(amount) || amount <= 0 || Math.abs(scaled - amount) > 1e-6) {
    throw issue('GAME_PROVIDER_AMOUNT_INVALID', 400);
  }
  return amount;
}
export const gameProvider = Object.freeze({
  get enabled(){return enabled||production.enabled||demo.enabled;},
  get productionEnabled(){return production.enabled===true;}
  requestId(...parts) { return createHash('sha256').update([GAME_ID, ...parts].join('|')).digest('hex'); },
  async consumeLaunch({ launchToken, exchangeId }) {
    if(demo.isTicket(launchToken)){
      const d=await demo.consume(launchToken,exchangeId);
      return {provider:'PROVIDER',userId:d.externalPlayerId,partnerId:d.integratorId,
          externalPlayerId:d.externalPlayerId,launchId:d.launchId,userName:'Player',
          currency:'USD',walletDecimals:2,locale:'en',returnUrl:null};
    }
    if(production.enabled){
      const i=await production.consumeLaunch(launchToken,exchangeId);
      return {provider:'PROVIDER',userId:i.externalPlayerId,
  partnerId:i.operatorCode,operatorCode:i.operatorCode,
  externalPlayerId:i.externalPlayerId,launchId:i.launchId,
  userName:'Player',currency:i.currency,walletDecimals:i.decimals,
  locale:'en',returnUrl:null,productionWallet:true,
  gameId:i.gameId,sessionToken:i.sessionToken,decimals:i.decimals,
  expiresAt:i.expiresAt};
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(launchToken || '')) || !identifier.test(String(exchangeId || ''))) {
      throw issue('GAME_PROVIDER_LAUNCH_INVALID', 400);
    }
    const data = await post('launch/consume', { gameId: GAME_ID, launchToken, exchangeId });
    if (data.gameId !== GAME_ID || !data.walletSandboxAvailable || !data.wallet ||
      !data.integratorId || !data.externalPlayerId ||
      !/^[A-Z0-9]{3,8}$/.test(data.wallet.currency || '') ||
      !Number.isInteger(data.wallet.decimals) || data.wallet.decimals < 0 || data.wallet.decimals > 4) {
      throw issue('GAME_PROVIDER_LAUNCH_RESPONSE_INVALID');
    }
    return { provider: 'PROVIDER', partnerId: String(data.integratorId),
      userId: String(data.externalPlayerId), launchId: String(data.launchId),
      userName: 'Player', currency: data.wallet.currency, walletDecimals: data.wallet.decimals,
      locale: data.locale || 'en', returnUrl: null };
  },
  async getBalance(identity) {
    if(demo.isSession(identity)){
      const d=await demo.balance(identity);
      return {available:d.balanceMinor/100,currency:'USD'};
    }
    if(production.enabled){
     const data=await production.balance(identity);
     return {available:data.balanceMinor/10**identity.walletDecimals,currency:data.currency};
    }
    const wallet = validateWallet(identity);
    const data = await post('wallet/balance', { gameId: GAME_ID, launchId: wallet.launchId });
    if (!Number.isSafeInteger(data.balanceMinor) || data.balanceMinor < 0 || data.currency !== wallet.currency) {
      throw issue('GAME_PROVIDER_BALANCE_INVALID');
    }
    return { available: data.balanceMinor / (10 ** wallet.walletDecimals), currency: data.currency };
  },
  async operation(identity, operation, { runId, amount, transactionId, betTransactionId = null }) {
    if(demo.isSession(identity))return demo.operation(identity,operation,
      {roundId:runId,amount,transactionId,betTransactionId});
    if(production.enabled){
     if(!['bet','win','refund'].includes(operation))
      throw Object.assign(new Error('PRODUCTION_GAME_ACTION_UNSUPPORTED'),{code:'PRODUCTION_GAME_ACTION_UNSUPPORTED',status:403});
     return production.operation(identity,operation,{
      roundId:runId,amount,transactionId,betTransactionId});
    }
    const wallet = validateWallet(identity);
    if (!['bet','win','refund'].includes(operation) || !identifier.test(transactionId || '') ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(runId || ''))) throw issue('GAME_PROVIDER_TRANSACTION_INVALID', 400);
    const data = await post(`wallet/${operation}`, {
      gameId: GAME_ID, launchId: wallet.launchId, roundId: runId, transactionId,
      amountMinor: amountMinor(amount, wallet.walletDecimals), currency: wallet.currency,
      ...(betTransactionId ? { betTransactionId } : {}),
    });
    if (data.status !== 'succeeded' || data.transactionId !== transactionId) {
      throw issue('GAME_PROVIDER_TRANSACTION_PENDING');
    }
    return data;
  },
});

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { ensurePhase8Store, recordTelemetry, validateCoreSnapshot, applyValidationResult, buildTelemetrySummary, buildBalanceReport, PHASE8_TARGETS, bossHpForDifficulty } from './production.js';
import { createSideSixClient } from './sidesix.js';
import { createPlatformClient } from './platform.js';
import { platformSessionStore } from './platformSessionStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.STORE_PATH ? resolve(process.env.STORE_PATH) : join(__dirname, '..', 'data', 'store.json');
const PORT = Number(process.env.PORT || 3001);
const sideSix = createSideSixClient();
const platform = createPlatformClient();
const ENTRY_MIN = 50;
const ENTRY_STEP = 50;
const ENTRY_MAX = 1_000_000;
const configuredDefaultPlayerBalance = Number(process.env.DEFAULT_PLAYER_BALANCE);
const DEFAULT_PLAYER_BALANCE = Number.isFinite(configuredDefaultPlayerBalance)
  ? Math.max(0, Math.min(1_000_000_000, configuredDefaultPlayerBalance))
  : 5000;
const PLAYER_ID_PATTERN = /^player-[A-Za-z0-9_-]{12,96}$/;
const DIFFICULTY_ECONOMY = Object.freeze({
  easy: Object.freeze({
    startMultiplier: 1.50, comboWindow: 2.50,
    comboSteps: Object.freeze([1, 1.15, 1.30, 1.45, 1.60, 1.80, 2.00]),
    scoreGates: Object.freeze({ 3: 15300, 5: 35700, 7: 63750, 9: 97750, 10: 127500 }),
    checkpointMultipliers: Object.freeze({ 3: 1.80, 5: 2.20, 7: 2.70, 9: 3.30, 10: 4.00 })
  }),
  medium: Object.freeze({
    startMultiplier: 2.25, comboWindow: 1.80,
    comboSteps: Object.freeze([1, 1.20, 1.40, 1.60, 2.00, 2.50, 3.00]),
    scoreGates: Object.freeze({ 3: 18000, 5: 42000, 7: 75000, 9: 115000, 10: 150000 }),
    checkpointMultipliers: Object.freeze({ 3: 2.75, 5: 3.40, 7: 4.20, 9: 5.20, 10: 6.25 })
  }),
  hard: Object.freeze({
    startMultiplier: 4.00, comboWindow: 1.25,
    comboSteps: Object.freeze([1, 1.50, 2.00, 2.50, 3.00, 3.50, 4.00]),
    scoreGates: Object.freeze({ 3: 21600, 5: 50400, 7: 90000, 9: 138000, 10: 180000 }),
    checkpointMultipliers: Object.freeze({ 3: 4.80, 5: 5.80, 7: 7.00, 9: 8.50, 10: 10.00 })
  })
});
const CASHOUT_WAVES = Object.freeze([3, 5, 7, 9, 10]);
function economyForDifficulty(difficulty = 'medium') {
  return DIFFICULTY_ECONOMY[String(difficulty || '').toLowerCase()] || DIFFICULTY_ECONOMY.medium;
}
function scoreGateForDifficulty(wave, difficulty = 'medium') {
  return Number(economyForDifficulty(difficulty).scoreGates[Number(wave)] || 0);
}
function checkpointMultiplierForDifficulty(wave, difficulty = 'medium') {
  return Number(economyForDifficulty(difficulty).checkpointMultipliers[Number(wave)] || 0);
}
function startMultiplierForDifficulty(difficulty = 'medium') {
  return Number(economyForDifficulty(difficulty).startMultiplier || 0);
}
function comboMaxForDifficulty(difficulty = 'medium') {
  return Math.max(...economyForDifficulty(difficulty).comboSteps);
}
const ALLOWED_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const ALLOWED_PATTERNS = new Set(['singleDive', 'twinDive', 'zigzag', 'pincer', 'swarm', 'crossfire', 'spiral', 'charge', 'eliteAssault']);
const SCORE = Object.freeze({ fighter: 100, diver: 150, shooter: 200, heavy: 300, charger: 300, elite: 500, miniBoss: 1000, finalBoss: 5000 });
const DECISION_SECONDS = 8;
const WAVE = Object.freeze({
  1: { enemies: 12, checkpoint: false },
  2: { enemies: 16, checkpoint: false },
  3: { enemies: 18, checkpoint: true, scoreGate: 18000, multiplier: 2.75 },
  4: { enemies: 20, checkpoint: false },
  5: { enemies: 1, checkpoint: true, scoreGate: 42000, multiplier: 3.40 },
  6: { enemies: 20, checkpoint: false },
  7: { enemies: 22, checkpoint: true, scoreGate: 75000, multiplier: 4.20 },
  8: { enemies: 25, checkpoint: false },
  9: { enemies: 22, checkpoint: true, scoreGate: 115000, multiplier: 5.20 },
  10: { enemies: 1, checkpoint: false, final: true, scoreGate: 150000, multiplier: 6.25 }
});
const CHECKPOINTS = Object.freeze(CASHOUT_WAVES.map((wave) => Object.freeze({
  wave,
  scoreGate: scoreGateForDifficulty(wave, 'medium'),
  multiplier: checkpointMultiplierForDifficulty(wave, 'medium')
})));
function checkpointsForDifficulty(difficulty = 'medium') {
  return CASHOUT_WAVES.map((wave) => ({
    wave,
    scoreGate: scoreGateForDifficulty(wave, difficulty),
    multiplier: checkpointMultiplierForDifficulty(wave, difficulty)
  }));
}

const now = () => new Date().toISOString();
function ensureStoreFile() {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  if (!existsSync(STORE_PATH)) {
    const initial = ensurePhase8Store({ players: {}, sessions: {}, transactions: [], telemetry: { version: 1, events: [] } });
    writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2));
  }
}
function readStore() {
  ensureStoreFile();
  const store = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  return ensurePhase8Store(store);
}
function writeStore(store) {
  ensureStoreFile();
  ensurePhase8Store(store);
  const tempPath = `${STORE_PATH}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, STORE_PATH);
}
function jsonReplacer(key, value) {
  if (['sideSix', 'platformWallet', 'authorizeTransactionId', 'holdId', 'sessionTokenHash'].includes(key)) return undefined;
  return value;
}
function json(res, status, payload) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Version, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Vary': 'Origin'
  };
  if (res.__corsOrigin) headers['Access-Control-Allow-Origin'] = res.__corsOrigin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload, jsonReplacer));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const maxBodyBytes = Math.max(16_384, Math.min(1_000_000, Number(process.env.MAX_BODY_BYTES || 131_072)));
    req.on('data', (chunk) => { raw += chunk; if (raw.length > maxBodyBytes) reject(new Error('Body too large')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function nonNegativeInt(value, fallback = 0, max = 1_000_000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(number)));
}
function finiteNumber(value, fallback = 0, min = 0, max = 1_000_000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
function sanitizeMonotonicMap(previousMap = {}, requestedMap = {}, allowedKeys = []) {
  const result = {};
  for (const key of allowedKeys) {
    const previous = nonNegativeInt(previousMap[key], 0, 100_000);
    result[key] = Math.max(previous, nonNegativeInt(requestedMap?.[key], previous, 100_000));
  }
  return result;
}
function scoreBase(killsByType = {}) {
  return Object.entries(SCORE).reduce((sum, [type, value]) => sum + nonNegativeInt(killsByType[type], 0, 100_000) * value, 0);
}
function subtractMaps(total = {}, removed = {}) {
  return Object.fromEntries(Object.keys(SCORE).map((type) => [type, Math.max(0, nonNegativeInt(total[type]) - nonNegativeInt(removed[type]))]));
}
function coreStart(session) {
  const c = session.coreState || {};
  return {
    score: nonNegativeInt(session.score, 0, 10_000_000),
    kills: nonNegativeInt(c.kills),
    shotsFired: nonNegativeInt(c.shotsFired),
    shotsHit: nonNegativeInt(c.shotsHit),
    damageTaken: nonNegativeInt(c.damageTaken, 0, 3),
    killsByType: { ...(c.killsByType || {}) },
    bombKillsByType: { ...(c.bombKillsByType || {}) },
    dangerKillsByType: { ...(c.dangerKillsByType || {}) },
    patternActivations: { ...(c.patternActivations || {}) }
  };
}
function completedBonusTotal(session) {
  return (session.completedWaves || []).reduce((sum, row) => sum + nonNegativeInt(row.accuracyBonus) + nonNegativeInt(row.perfectBonus) + nonNegativeInt(row.aceBonus), 0);
}
function defaultCore() {
  return {
    kills: 0, shotsFired: 0, shotsHit: 0, damageTaken: 0,
    killsByType: Object.fromEntries(Object.keys(SCORE).map((type) => [type, 0])),
    bombKillsByType: Object.fromEntries(Object.keys(SCORE).map((type) => [type, 0])),
    dangerKillsByType: Object.fromEntries(Object.keys(SCORE).map((type) => [type, 0])),
    patternActivations: Object.fromEntries([...ALLOWED_PATTERNS].map((id) => [id, 0])),
    lastPattern: '', comboIndex: 0, comboMultiplier: 1, comboTimer: 0,
    overdriveEnergy: 0, overdriveActiveRemaining: 0, bombUsed: false, bombAvailable: true,
    waveElapsed: 0, enemiesRemaining: WAVE[1].enemies,
    miniBossHp: 0, miniBossMaxHp: 0, finalBossHp: 0, finalBossMaxHp: 0, finalBossPhase: 0
  };
}
function applyCoreSnapshot(session, body) {
  const previous = { ...defaultCore(), ...(session.coreState || {}) };
  const shotsFired = Math.max(previous.shotsFired || 0, nonNegativeInt(body.shotsFired, previous.shotsFired || 0, 100_000));
  const shotsHit = Math.min(shotsFired, Math.max(previous.shotsHit || 0, nonNegativeInt(body.shotsHit, previous.shotsHit || 0, 100_000)));
  const damageTaken = Math.min(3, Math.max(previous.damageTaken || 0, nonNegativeInt(body.damageTaken, previous.damageTaken || 0, 3)));
  const bombUsed = Boolean(previous.bombUsed || body.bombUsed === true || body.bombAvailable === false);

  const requestedBombKills = sanitizeMonotonicMap(previous.bombKillsByType || {}, body.bombKillsByType || {}, Object.keys(SCORE));
  const bombKillsByType = {};
  for (const type of Object.keys(SCORE)) {
    const prev = nonNegativeInt(previous.bombKillsByType?.[type]);
    bombKillsByType[type] = bombUsed ? requestedBombKills[type] : prev;
  }
  const bombKillTotal = Object.values(bombKillsByType).reduce((sum, value) => sum + nonNegativeInt(value), 0);

  const requestedKills = sanitizeMonotonicMap(previous.killsByType || {}, body.killsByType || {}, Object.keys(SCORE));
  const killsByType = { ...previous.killsByType };
  const previousKillTotal = Object.values(previous.killsByType || {}).reduce((sum, value) => sum + nonNegativeInt(value), 0);
  let remainingKillCapacity = Math.max(0, shotsHit * 2 + bombKillTotal - previousKillTotal);
  for (const type of Object.keys(SCORE)) {
    const prev = nonNegativeInt(previous.killsByType?.[type]);
    const requested = nonNegativeInt(requestedKills[type], prev, 100_000);
    const increment = Math.min(Math.max(0, requested - prev), remainingKillCapacity);
    killsByType[type] = prev + increment;
    remainingKillCapacity -= increment;
    bombKillsByType[type] = Math.min(bombKillsByType[type], killsByType[type]);
  }
  const kills = Object.values(killsByType).reduce((sum, value) => sum + nonNegativeInt(value), 0);
  const requestedDangerKills = sanitizeMonotonicMap(previous.dangerKillsByType || {}, body.dangerKillsByType || {}, Object.keys(SCORE));
  const dangerKillsByType = {};
  for (const type of Object.keys(SCORE)) {
    const previousDanger = nonNegativeInt(previous.dangerKillsByType?.[type]);
    const nonBombKills = Math.max(0, nonNegativeInt(killsByType[type]) - nonNegativeInt(bombKillsByType[type]));
    const requestedDanger = ['miniBoss', 'finalBoss'].includes(type) ? previousDanger : nonNegativeInt(requestedDangerKills[type], previousDanger, 100_000);
    dangerKillsByType[type] = Math.max(previousDanger, Math.min(requestedDanger, nonBombKills));
  }
  const patternActivations = sanitizeMonotonicMap(previous.patternActivations || {}, body.patternActivations || {}, [...ALLOWED_PATTERNS]);
  const requestedPattern = String(body.lastPattern || previous.lastPattern || '');
  const lastPattern = ALLOWED_PATTERNS.has(requestedPattern) ? requestedPattern : (previous.lastPattern || '');
  const economy = economyForDifficulty(session.difficulty);
  const comboSteps = economy.comboSteps;
  const comboIndex = Math.max(0, Math.min(comboSteps.length - 1, nonNegativeInt(body.comboIndex, previous.comboIndex || 0, comboSteps.length - 1)));
  const comboMultiplier = comboSteps[comboIndex] || 1;
  const comboMax = comboMaxForDifficulty(session.difficulty);

  const scoredKills = subtractMaps(killsByType, bombKillsByType);
  const dangerScoreCap = Math.round(scoreBase(dangerKillsByType) * comboMax * 0.25);
  const maxCombatScore = scoreBase(scoredKills) * comboMax + dangerScoreCap + completedBonusTotal(session);
  const requestedScore = Math.max(session.score || 0, nonNegativeInt(body.score, session.score || 0, 10_000_000));
  const score = Math.min(requestedScore, Math.max(session.score || 0, maxCombatScore));

  session.coreState = {
    kills, shotsFired, shotsHit, damageTaken, killsByType, bombKillsByType, dangerKillsByType,
    patternActivations, lastPattern, comboIndex, comboMultiplier,
    comboTimer: finiteNumber(body.comboTimer, previous.comboTimer || 0, 0, economy.comboWindow),
    overdriveEnergy: finiteNumber(body.overdriveEnergy, previous.overdriveEnergy || 0, 0, 100),
    overdriveActiveRemaining: finiteNumber(body.overdriveActiveRemaining, previous.overdriveActiveRemaining || 0, 0, 7),
    bombUsed, bombAvailable: !bombUsed,
    waveElapsed: finiteNumber(body.waveElapsed, previous.waveElapsed || 0, 0, 240),
    enemiesRemaining: nonNegativeInt(body.enemiesRemaining, previous.enemiesRemaining || 0, 100),
    miniBossHp: nonNegativeInt(body.miniBossHp, previous.miniBossHp || 0, 400),
    miniBossMaxHp: nonNegativeInt(body.miniBossMaxHp, previous.miniBossMaxHp || 0, 400),
    finalBossHp: nonNegativeInt(body.finalBossHp, previous.finalBossHp || 0, 500),
    finalBossMaxHp: nonNegativeInt(body.finalBossMaxHp, previous.finalBossMaxHp || 0, 500),
    finalBossPhase: nonNegativeInt(body.finalBossPhase, previous.finalBossPhase || 0, 3)
  };
  session.score = score;
  session.lives = Math.max(0, 3 - damageTaken);
  session.updatedAt = now();
  return session;
}
function accuracyRate(accuracy) {
  if (accuracy >= 95) return 0.15;
  if (accuracy >= 85) return 0.10;
  if (accuracy >= 75) return 0.05;
  return 0;
}
function transaction(store, { playerId, sessionId, type, amount, balanceAfter, meta = {} }) {
  const row = { id: randomUUID(), playerId, sessionId, type, amount, balanceAfter, meta, createdAt: now() };
  store.transactions.push(row);
  return row;
}
function validEntryAmount(value) {
  return Number.isInteger(value) && value >= ENTRY_MIN && value <= ENTRY_MAX && value % ENTRY_STEP === 0;
}
function unlockedTier(session) {
  let best = null;
  for (const checkpoint of checkpointsForDifficulty(session.difficulty)) {
    if (checkpoint.wave > Number(session.wave || 0)) break;
    if (Number(session.score || 0) >= checkpoint.scoreGate) best = { ...checkpoint };
  }
  return best;
}
function nextTier(wave, difficulty = 'medium') {
  return checkpointsForDifficulty(difficulty).find((cp) => cp.wave > Number(wave || 0)) || null;
}
function checkpointPayload(session, def) {
  const best = unlockedTier(session);
  const next = nextTier(session.wave, session.difficulty);
  const startMultiplier = startMultiplierForDifficulty(session.difficulty);
  const currentMultiplier = best?.multiplier || startMultiplier;
  const scoreGate = scoreGateForDifficulty(session.wave, session.difficulty);
  const checkpointMultiplier = checkpointMultiplierForDifficulty(session.wave, session.difficulty);
  return {
    wave: session.wave,
    scoreGate,
    multiplier: checkpointMultiplier,
    scoreUnlocked: Number(session.score || 0) >= scoreGate,
    currentScore: session.score,
    bestUnlockedWave: best?.wave || null,
    bestUnlockedMultiplier: currentMultiplier,
    payoutSource: best ? 'checkpoint' : 'start',
    startMultiplier,
    currentReward: Math.round(session.entryAmount * currentMultiplier),
    potentialReward: Math.round(session.entryAmount * checkpointMultiplier),
    nextCheckpointWave: next?.wave || null,
    nextScoreGate: next?.scoreGate || null,
    nextMultiplier: next?.multiplier || null,
    nextReward: next ? Math.round(session.entryAmount * next.multiplier) : null,
    decisionSeconds: DECISION_SECONDS,
    decisionStartedAt: now(),
    decisionDeadline: new Date(Date.now() + DECISION_SECONDS * 1000).toISOString(),
    canContinue: session.wave < 10
  };
}
function buildSettlement(session, tier, mode) {
  const multiplier = tier?.multiplier || startMultiplierForDifficulty(session.difficulty);
  const reward = Math.round(session.entryAmount * multiplier);
  return {
    wave: session.wave, multiplier, tierWave: tier?.wave || null, reward,
    payoutSource: tier ? 'checkpoint' : 'start',
    entryAmount: session.entryAmount, netProfit: reward - session.entryAmount,
    mode, score: session.score, settledAt: now()
  };
}
function walletState(session) {
  if (session?.walletMode === 'SIDESIX') return session.sideSix || null;
  if (session?.walletMode === 'PLATFORM') return session.platformWallet || null;
  return null;
}
function isExternalWalletSession(session) {
  return Boolean(['SIDESIX', 'PLATFORM'].includes(session?.walletMode) && walletState(session)?.userId);
}
async function settleExternalPrize(store, session, cashout) {
  if (!isExternalWalletSession(session)) return;
  const wallet = walletState(session);
  if (wallet.settlementStatus === 'settled') return;

  if (session.walletMode === 'SIDESIX') {
    const requestId = wallet.settleRequestId || sideSix.requestId('galaga', session.id, 'settle');
    wallet.settleRequestId = requestId;
    wallet.settlementStatus = 'pending';
    wallet.pendingPrize = cashout.reward;
    wallet.pendingCashout = { ...cashout };
    writeStore(store);
    await sideSix.settle({
      userId: wallet.userId,
      wonPrizeValue: cashout.reward,
      authorizeTransactionId: wallet.authorizeTransactionId,
      requestId,
      playId: 1,
    });
    wallet.settlementStatus = 'settled';
    wallet.pendingPrize = null;
    wallet.pendingCashout = null;
    wallet.settledAt = now();
    return;
  }

  const requestId = wallet.payoutRequestId || platform.requestId('galaga', session.id, 'payout');
  wallet.payoutRequestId = requestId;
  wallet.settlementStatus = 'pending';
  wallet.pendingPrize = cashout.reward;
  wallet.pendingCashout = { ...cashout };
  writeStore(store);
  await platform.payout({
    userId: wallet.userId,
    matchId: wallet.matchId,
    amount: cashout.reward,
    currency: wallet.currency,
    idempotencyKey: requestId,
    reason: 'Galaga run payout',
    metadata: { sessionId: session.id, wave: cashout.wave, difficulty: session.difficulty, multiplier: cashout.multiplier },
  });
  wallet.settlementStatus = 'settled';
  wallet.pendingPrize = null;
  wallet.pendingCashout = null;
  wallet.settledAt = now();
}
async function cancelUnstartedExternalRun(store, session, reason = 'game_failed') {
  if (!isExternalWalletSession(session)) return false;
  const wallet = walletState(session);
  if (wallet.playStarted) return false;

  if (session.walletMode === 'SIDESIX') {
    if (wallet.refundStatus === 'refunded') return false;
    const requestId = wallet.refundRequestId || sideSix.requestId('galaga', session.id, 'refund');
    wallet.refundRequestId = requestId;
    wallet.refundStatus = 'pending';
    writeStore(store);
    await sideSix.refund({ userId: wallet.userId, authorizeTransactionId: wallet.authorizeTransactionId, requestId, reason });
    wallet.refundStatus = 'refunded';
    wallet.refundedAt = now();
    return true;
  }

  if (wallet.releasedAt || wallet.refundedAt) return false;
  if (wallet.capturedAt) {
    const requestId = wallet.refundRequestId || platform.requestId('galaga', session.id, 'refund');
    wallet.refundRequestId = requestId;
    writeStore(store);
    await platform.refund({
      userId: wallet.userId, matchId: wallet.matchId, holdId: wallet.holdId,
      idempotencyKey: requestId, reason: 'Galaga run cancelled before play', metadata: { sessionId: session.id },
    });
    wallet.refundedAt = now();
  } else {
    const requestId = wallet.releaseRequestId || platform.requestId('galaga', session.id, 'release');
    wallet.releaseRequestId = requestId;
    writeStore(store);
    await platform.release({
      userId: wallet.userId, matchId: wallet.matchId, holdId: wallet.holdId,
      idempotencyKey: requestId, metadata: { sessionId: session.id, reason },
    });
    wallet.releasedAt = now();
  }
  return true;
}
async function refreshPlatformBalance(player) {
  if (!player || player.walletMode !== 'PLATFORM' || !player.externalUserId) return player;
  const snapshot = await platform.getBalance(player.externalUserId);
  player.balance = Number(snapshot.available);
  player.walletCurrency = snapshot.currency || player.walletCurrency || 'COIN';
  player.updatedAt = now();
  return player;
}
async function applySettlementCredit(store, session, cashout, transactionType) {
  const player = store.players[session.playerId];
  if (!player) throw new Error('Player not found');
  if (isExternalWalletSession(session)) {
    await settleExternalPrize(store, session, cashout);
    if (session.walletMode === 'SIDESIX') player.balance = null;
    else await refreshPlatformBalance(player);
    player.walletMode = session.walletMode;
  } else {
    player.balance += cashout.reward;
  }
  session.cashout = cashout;
  session.cashoutWave = cashout.wave;
  session.cashoutMultiplier = cashout.multiplier;
  session.reward = cashout.reward;
  session.checkpoint = null;
  session.updatedAt = cashout.settledAt;
  transaction(store, {
    playerId: player.id, sessionId: session.id, type: transactionType,
    amount: cashout.reward, balanceAfter: player.balance,
    meta: { wave: cashout.wave, multiplier: cashout.multiplier, tierWave: cashout.tierWave, mode: cashout.mode, walletMode: session.walletMode || 'LOCAL' }
  });
  return player;
}
async function settleCashout(store, session, mode = 'manual') {
  if (session.state === 'RESULT' && session.cashout) return { player: store.players[session.playerId], session };
  if (session.state !== 'CHECKPOINT') throw new Error(`Cashout cannot settle from ${session.state}`);
  const wallet = walletState(session);
  const pendingCashout = isExternalWalletSession(session) && wallet?.settlementStatus === 'pending'
    ? wallet.pendingCashout
    : null;
  const tier = unlockedTier(session);
  const cashout = pendingCashout || buildSettlement(session, tier, mode);
  session.checkpointHistory ||= [];
  if (!pendingCashout && session.checkpoint) session.checkpointHistory.push({ ...session.checkpoint, decision: mode === 'auto' ? 'AUTO_CASHOUT' : 'CASHOUT', decidedAt: cashout.settledAt });
  const player = await applySettlementCredit(store, session, cashout, 'CASHOUT_CREDIT');
  session.state = 'RESULT';
  recordTelemetry(store, { type: mode === 'auto' ? 'cashout_auto' : 'cashout_manual', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: { score: session.score, multiplier: cashout.multiplier, reward: cashout.reward, netProfit: cashout.netProfit, tierWave: cashout.tierWave } });
  return { player, session };
}
async function settleBossCompletion(store, session) {
  if (session.state === 'BOSS_COMPLETE' && session.cashout) return { player: store.players[session.playerId], session };
  const wallet = walletState(session);
  const pendingCashout = isExternalWalletSession(session) && wallet?.settlementStatus === 'pending'
    ? wallet.pendingCashout
    : null;
  const tier = unlockedTier(session);
  const cashout = pendingCashout || buildSettlement(session, tier, 'boss_complete');
  const player = await applySettlementCredit(store, session, cashout, 'FINAL_PAYOUT_CREDIT');
  session.state = 'BOSS_COMPLETE';
  session.bossComplete = {
    bossKilled: true,
    finalTierUnlocked: tier?.wave === 10,
    finalScoreGate: scoreGateForDifficulty(10, session.difficulty),
    completedAt: cashout.settledAt
  };
  recordTelemetry(store, { type: 'boss_complete', playerId: session.playerId, sessionId: session.id, wave: 10, difficulty: session.difficulty, data: { score: session.score, multiplier: cashout.multiplier, reward: cashout.reward, finalTierUnlocked: tier?.wave === 10 } });
  return { player, session };
}
async function autoSettleExpiredCheckpoint(store, session) {
  if (!session || session.state !== 'CHECKPOINT' || !session.checkpoint?.decisionDeadline) return false;
  if (Date.now() < Date.parse(session.checkpoint.decisionDeadline)) return false;
  await settleCashout(store, session, 'auto');
  return true;
}
function startNextWave(session) {
  session.wave += 1;
  session.state = 'WAVE_PLAYING';
  session.checkpoint = null;
  session.waveState = { startCore: coreStart(session), startedAt: now(), lastResult: null };
  session.coreState.waveElapsed = 0;
  session.coreState.enemiesRemaining = WAVE[session.wave]?.enemies || 0;
  const miniBossHp = bossHpForDifficulty('miniBoss', session.difficulty);
  const finalBossHp = bossHpForDifficulty('finalBoss', session.difficulty);
  session.coreState.miniBossHp = session.wave === 5 ? miniBossHp : 0;
  session.coreState.miniBossMaxHp = session.wave === 5 ? miniBossHp : 0;
  session.coreState.finalBossHp = session.wave === 10 ? finalBossHp : 0;
  session.coreState.finalBossMaxHp = session.wave === 10 ? finalBossHp : 0;
  session.coreState.finalBossPhase = session.wave === 10 ? 1 : 0;
  session.updatedAt = now();
}
function normalizePlayerId(value) {
  const playerId = String(value || '').trim();
  return PLAYER_ID_PATTERN.test(playerId) ? playerId : null;
}
function playerIdForIdentity(identity, requestedPlayerId) {
  if (identity?.provider === 'SIDESIX' && identity?.userId) return `player-sidesix-${identity.userId}`;
  if (identity?.provider === 'PLATFORM' && identity?.userId) return `player-platform-${identity.userId}`;
  return normalizePlayerId(requestedPlayerId);
}
function ensurePlayer(store, requestedPlayerId, identity = null) {
  const playerId = playerIdForIdentity(identity, requestedPlayerId);
  if (!playerId) return null;
  const provider = ['SIDESIX', 'PLATFORM'].includes(identity?.provider) ? identity.provider : 'LOCAL';
  if (!store.players[playerId]) {
    store.players[playerId] = {
      id: playerId,
      displayName: identity?.userName || 'STARBLAST',
      balance: provider === 'SIDESIX' ? null : provider === 'PLATFORM' ? Number(identity?.balance ?? 0) : DEFAULT_PLAYER_BALANCE,
      walletMode: provider,
      externalUserId: provider === 'LOCAL' ? null : String(identity.userId),
      walletCurrency: identity?.currency || (provider === 'PLATFORM' ? 'COIN' : provider === 'SIDESIX' ? sideSix.configuration.currency : 'COINS'),
      activeSessionId: null,
      createdAt: now(),
      updatedAt: now()
    };
    return { player: store.players[playerId], created: true };
  }
  const player = store.players[playerId];
  if (provider !== 'LOCAL') {
    player.displayName = identity?.userName || player.displayName || 'PLAYER';
    player.walletMode = provider;
    player.externalUserId = String(identity.userId);
    player.walletCurrency = identity?.currency || player.walletCurrency;
    if (provider === 'SIDESIX') player.balance = null;
    else if (Number.isFinite(Number(identity?.balance))) player.balance = Number(identity.balance);
  }
  return { player, created: false };
}
function getPlayerPayload(store, playerId) {
  const player = store.players[playerId];
  if (!player) return null;
  const activeSession = player.activeSessionId ? store.sessions[player.activeSessionId] || null : null;
  return { player, activeSession };
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+([A-Fa-f0-9]{64})$/);
  return match ? match[1] : '';
}
function requirePlatformIdentity(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const session = platformSessionStore.get(token);
  if (!session?.userId || !['SIDESIX', 'PLATFORM'].includes(session.provider)) {
    const error = new Error('Valid external wallet launch session required');
    error.status = 401;
    error.statusCode = 401;
    error.code = 'WALLET_SESSION_REQUIRED';
    throw error;
  }
  return session;
}
function assertSessionOwnership(session, identity) {
  const provider = session?.walletMode || 'LOCAL';
  if (provider === 'LOCAL') {
    if (identity) {
      const error = new Error('Wallet provider mismatch'); error.status = error.statusCode = 403; error.code = 'WALLET_SESSION_MISMATCH'; throw error;
    }
    return;
  }
  const wallet = walletState(session);
  if (!identity || identity.provider !== provider || String(wallet?.userId || '') !== String(identity.userId || '')) {
    const error = new Error('Session does not belong to this wallet player');
    error.status = 403; error.statusCode = 403; error.code = 'WALLET_SESSION_MISMATCH'; throw error;
  }
}

const RATE_BUCKETS = new Map();
function isLanDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
    if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
    const private172 = host.match(/^172\.(\d{1,2})\.(\d{1,3})\.(\d{1,3})$/);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}
const DEFAULT_PRODUCTION_ORIGINS = Object.freeze([
  'https://galaga-fe.vercel.app'
]);
function normalizeCorsOrigin(value = '') {
  return String(value || '').trim().replace(/\/$/, '');
}
function resolveCorsOrigin(req) {
  const origin = normalizeCorsOrigin(req.headers.origin || '');
  const production = process.env.NODE_ENV === 'production';
  const configured = String(process.env.CORS_ORIGIN || (production ? '' : '*')).trim();
  const configuredOrigins = configured
    .split(',')
    .map(normalizeCorsOrigin)
    .filter(Boolean);

  if (!production) {
    if (!origin) return configured === '*' ? '*' : (configuredOrigins[0] || '*');
    if (configured === '*' || configuredOrigins.includes(origin) || isLanDevelopmentOrigin(origin)) return origin;
    return null;
  }

  // Keep the production FE reachable even if Render's CORS_ORIGIN env var is
  // missing, stale, or was not applied by a previous deployment. Explicit
  // configured origins remain additive, and '*' is still honored when chosen.
  if (configured === '*') return '*';
  const allowed = new Set([...DEFAULT_PRODUCTION_ORIGINS, ...configuredOrigins]);
  if (!origin) return DEFAULT_PRODUCTION_ORIGINS[0];
  return allowed.has(origin) ? origin : null;
}
function isRateLimited(req, path) {
  if (req.method === 'OPTIONS' || path === '/api/health') return false;
  const limit = Math.max(60, Math.min(5000, Number(process.env.RATE_LIMIT_PER_MINUTE || 240)));
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const count = (RATE_BUCKETS.get(key) || 0) + 1;
  RATE_BUCKETS.set(key, count);
  if (RATE_BUCKETS.size > 5000) {
    for (const bucketKey of RATE_BUCKETS.keys()) if (!bucketKey.endsWith(`:${minute}`)) RATE_BUCKETS.delete(bucketKey);
  }
  return count > limit;
}
function adminAuthorized(req) {
  const expected = String(process.env.ADMIN_KEY || '');
  if (!expected && process.env.NODE_ENV !== 'production') return true;
  if (!expected) return false;
  return String(req.headers['x-admin-key'] || '') === expected;
}
function antiCheatEnforced() {
  const mode = String(process.env.ANTI_CHEAT_MODE || 'enforce').toLowerCase();
  return mode !== 'observe' && mode !== 'off';
}
function validateIncomingSnapshot(store, session, body, options = {}) {
  const result = validateCoreSnapshot(session, body, options);
  applyValidationResult(store, session, result, { endpoint: options.endpoint || 'core-state' });
  return result;
}

const server = http.createServer(async (req, res) => {
  res.__corsOrigin = resolveCorsOrigin(req);
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  if (isRateLimited(req, path)) return json(res, 429, { error: 'Rate limit exceeded' });
  try {
    if (req.method === 'GET' && path === '/') return json(res, 200, { ok: true, service: 'galaga-skill-wager-be', version: '0.8.1', health: '/api/health' });
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, service: 'galaga-skill-wager-be', phase: 8, version: '0.8.1', waves: 10, antiCheatMode: String(process.env.ANTI_CHEAT_MODE || 'enforce'), storeSchema: 8 });
    if (req.method === 'POST' && path === '/api/platform/launch') {
      const body = await readBody(req);
      let identity = null;
      if (body?.platformLaunchToken) {
        if (!platform.configuration.enabled) {
          const error = new Error('Platform wallet integration is disabled'); error.status = error.statusCode = 503; error.code = 'PLATFORM_NOT_CONFIGURED'; throw error;
        }
        const consumed = await platform.consumeLaunch({ launchToken: String(body.platformLaunchToken), exchangeId: String(body.exchangeId || randomUUID()) });
        identity = {
          provider: 'PLATFORM',
          userId: String(consumed.user.publicId),
          userName: String(consumed.user.displayName || 'Player'),
          avatarUrl: consumed.user.avatarUrl || null,
          locale: consumed.user.locale || null,
          returnUrl: null,
          currency: String(consumed.wallet.currency || 'COIN'),
          balance: Number(consumed.wallet.available || 0),
          launchId: consumed.launch.launchId,
        };
      } else if (body?.userId || body?.sig) {
        if (!sideSix.configuration.enabled) {
          const error = new Error('SideSix wallet integration is disabled'); error.status = error.statusCode = 503; error.code = 'SIDESIX_DISABLED'; throw error;
        }
        const verified = sideSix.verifyLaunch(body);
        identity = { ...verified, provider: 'SIDESIX', currency: sideSix.configuration.currency, balance: null };
      } else {
        return json(res, 200, { ok: true, mode: 'LOCAL', token: null, identity: null });
      }
      const gameSession = platformSessionStore.create(identity);
      return json(res, 201, {
        ok: true, mode: identity.provider, token: gameSession.token,
        identity: { userId: identity.userId, userName: identity.userName, returnUrl: identity.returnUrl || null, currency: identity.currency, balance: identity.balance }
      });
    }

    if (req.method === 'GET' && path === '/api/admin/telemetry/summary') {
      if (!adminAuthorized(req)) return json(res, 401, { error: 'Admin authorization required' });
      return json(res, 200, buildTelemetrySummary(readStore()));
    }
    if (req.method === 'GET' && path === '/api/admin/balance-report') {
      if (!adminAuthorized(req)) return json(res, 401, { error: 'Admin authorization required' });
      return json(res, 200, buildBalanceReport(readStore()));
    }
    if (req.method === 'GET' && path === '/api/admin/balance-targets') {
      if (!adminAuthorized(req)) return json(res, 401, { error: 'Admin authorization required' });
      return json(res, 200, PHASE8_TARGETS);
    }
    const auditMatch = path.match(/^\/api\/admin\/sessions\/([^/]+)\/audit$/);
    if (req.method === 'GET' && auditMatch) {
      if (!adminAuthorized(req)) return json(res, 401, { error: 'Admin authorization required' });
      const store = readStore(); const session = store.sessions[auditMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      const transactions = store.transactions.filter((row) => row.sessionId === session.id);
      const events = store.telemetry.events.filter((row) => row.sessionId === session.id);
      return json(res, 200, { session, antiCheat: session.antiCheat || null, transactions, events });
    }

    const platformIdentity = requirePlatformIdentity(req);

    if (req.method === 'POST' && path === '/api/players/ensure') {
      const body = await readBody(req);
      const store = readStore();
      const ensured = ensurePlayer(store, body.playerId, platformIdentity);
      if (!ensured) return json(res, 400, { error: 'Invalid player ID' });
      if (platformIdentity?.provider === 'PLATFORM') await refreshPlatformBalance(ensured.player);
      if (ensured.created || platformIdentity?.provider === 'PLATFORM') writeStore(store);
      const active = ensured.player.activeSessionId ? store.sessions[ensured.player.activeSessionId] : null;
      if (await autoSettleExpiredCheckpoint(store, active)) writeStore(store);
      return json(res, ensured.created ? 201 : 200, getPlayerPayload(store, ensured.player.id));
    }

    const playerMatch = path.match(/^\/api\/players\/([^/]+)$/);
    if (req.method === 'GET' && playerMatch) {
      const store = readStore();
      const requestedPlayerId = decodeURIComponent(playerMatch[1]);
      const playerId = playerIdForIdentity(platformIdentity, requestedPlayerId);
      if (!playerId) return json(res, 400, { error: 'Invalid player ID' });
      const player = store.players[playerId];
      if (!player) return json(res, 404, { error: 'Player not found' });
      const active = player.activeSessionId ? store.sessions[player.activeSessionId] : null;
      if (await autoSettleExpiredCheckpoint(store, active)) writeStore(store);
      if (platformIdentity?.provider === 'PLATFORM') { await refreshPlatformBalance(player); writeStore(store); }
      return json(res, 200, getPlayerPayload(store, playerId));
    }

    if (req.method === 'POST' && path === '/api/sessions/start') {
      const body = await readBody(req);
      const playerId = playerIdForIdentity(platformIdentity, body.playerId);
      if (!playerId) return json(res, 400, { error: 'Invalid player ID' });
      const entryAmount = Number(body.entryAmount);
      const difficulty = String(body.difficulty || '').toLowerCase();
      if (!validEntryAmount(entryAmount)) return json(res, 400, { error: `Invalid entry amount. Use ${ENTRY_STEP}-coin steps from ${ENTRY_MIN}.` });
      if (!ALLOWED_DIFFICULTIES.has(difficulty)) return json(res, 400, { error: 'Invalid difficulty' });

      const provider = platformIdentity?.provider || 'LOCAL';
      const store = readStore();
      const ensured = ensurePlayer(store, playerId, platformIdentity);
      const player = ensured.player;
      let session = player.activeSessionId ? store.sessions[player.activeSessionId] : null;

      if (session && !['RESULT', 'RUN_LOST', 'BOSS_COMPLETE'].includes(session.state)) {
        assertSessionOwnership(session, platformIdentity);
        const sameRunRequest = Number(session.entryAmount) === entryAmount && session.difficulty === difficulty;
        const resumable = sameRunRequest && (
          (provider === 'SIDESIX' && ['AUTHORIZING', 'ENTRY_PAID'].includes(session.state)) ||
          (provider === 'PLATFORM' && ['RESERVING', 'ENTRY_PAID'].includes(session.state))
        );
        if (!resumable) return json(res, 409, { error: 'Player already has an active run', activeSession: session });
        if (session.state === 'ENTRY_PAID') {
          if (provider === 'PLATFORM') await refreshPlatformBalance(player);
          return json(res, 200, { player, session });
        }
      } else if (session) {
        player.activeSessionId = null;
        session = null;
      }

      if (!session) {
        const sessionId = randomUUID();
        const created = now();
        const matchId = `galaga:${sessionId}`;
        session = {
          id: sessionId, playerId, entryAmount, difficulty,
          state: provider === 'SIDESIX' ? 'AUTHORIZING' : provider === 'PLATFORM' ? 'RESERVING' : 'ENTRY_PAID',
          walletMode: provider,
          sideSix: provider === 'SIDESIX' ? {
            userId: platformIdentity.userId, authorizeTransactionId: null,
            authorizeRequestId: sideSix.requestId('galaga', sessionId, 'authorize'),
            playStarted: false, settlementStatus: 'authorizing', refundStatus: null,
          } : null,
          platformWallet: provider === 'PLATFORM' ? {
            userId: platformIdentity.userId, currency: platformIdentity.currency || 'COIN', matchId, holdId: null,
            reserveRequestId: platform.requestId('galaga', sessionId, 'reserve'),
            captureRequestId: platform.requestId('galaga', sessionId, 'capture'),
            playStarted: false, settlementStatus: 'reserving',
          } : null,
          score: 0, lives: 3, reward: 0, gameSeed: randomUUID(), coreState: defaultCore(),
          waveState: { startCore: null, startedAt: null, lastResult: null }, completedWaves: [], checkpoint: null, checkpointHistory: [],
          cashout: null, bossComplete: null, antiCheat: { riskScore: 0, flags: [], rejectedSnapshots: 0, reviewRequired: false },
          clientVersion: String(req.headers['x-client-version'] || 'unknown').slice(0, 32), createdAt: created, updatedAt: created,
        };

        if (provider === 'LOCAL') {
          if (player.balance < entryAmount) return json(res, 409, { error: 'Insufficient coin balance' });
          player.balance -= entryAmount;
        } else if (provider === 'SIDESIX') {
          player.balance = null;
        }
        player.walletMode = provider;
        store.sessions[session.id] = session;
        player.activeSessionId = session.id;
        player.updatedAt = now();
        writeStore(store);
      }

      if (provider === 'SIDESIX' && session.state === 'AUTHORIZING') {
        try {
          const authorized = await sideSix.authorize({ userId: session.sideSix.userId, playCost: session.entryAmount, requestId: session.sideSix.authorizeRequestId });
          session.sideSix.authorizeTransactionId = authorized.transactionId;
          session.sideSix.settlementStatus = 'authorized';
          session.sideSix.authorizedAt = now();
          session.state = 'ENTRY_PAID'; session.updatedAt = now();
        } catch (error) {
          if (error?.code === 'INSUFFICIENT_BALANCE') {
            if (player.activeSessionId === session.id) player.activeSessionId = null;
            delete store.sessions[session.id]; writeStore(store);
          }
          throw error;
        }
      }

      if (provider === 'PLATFORM' && session.state === 'RESERVING') {
        try {
          const w = session.platformWallet;
          const reserved = await platform.reserve({
            userId: w.userId, matchId: w.matchId, amount: session.entryAmount, currency: w.currency, idempotencyKey: w.reserveRequestId,
            metadata: { game: 'galaga', sessionId: session.id, difficulty: session.difficulty },
          });
          const holdId = reserved?.hold?.holdId || reserved?.holdId;
          if (!holdId) { const error = new Error('Platform reserve response did not include holdId'); error.code = 'PLATFORM_RESERVE_INVALID'; error.status = error.statusCode = 503; throw error; }
          w.holdId = holdId; w.reservedAt = now(); w.settlementStatus = 'reserved';
          session.state = 'ENTRY_PAID'; session.updatedAt = now();
          await refreshPlatformBalance(player);
        } catch (error) {
          if (['INSUFFICIENT_BALANCE', 'WALLET_INSUFFICIENT_FUNDS'].includes(error?.code)) {
            if (player.activeSessionId === session.id) player.activeSessionId = null;
            delete store.sessions[session.id]; writeStore(store);
          }
          throw error;
        }
      }

      if (!session.entryTransactionId) {
        const debit = transaction(store, { playerId, sessionId: session.id, type: provider === 'PLATFORM' ? 'PLATFORM_RESERVE' : provider === 'SIDESIX' ? 'SIDESIX_AUTHORIZE' : 'ENTRY_DEBIT', amount: -entryAmount, balanceAfter: player.balance, meta: { difficulty, walletMode: session.walletMode } });
        session.entryTransactionId = debit.id;
        recordTelemetry(store, { type: 'session_start', playerId, sessionId: session.id, wave: 1, difficulty, data: { entryAmount, clientVersion: session.clientVersion, walletMode: session.walletMode } });
      }
      writeStore(store);
      return json(res, 201, { player, session });
    }

    const getSessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && getSessionMatch) {
      const store = readStore();
      const session = store.sessions[getSessionMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (await autoSettleExpiredCheckpoint(store, session)) writeStore(store);
      const sessionPlayer = store.players[session.playerId];
      if (session.walletMode === 'PLATFORM' && sessionPlayer) { await refreshPlatformBalance(sessionPlayer); writeStore(store); }
      return json(res, 200, { session, player: sessionPlayer });
    }

    const countdownMatch = path.match(/^\/api\/sessions\/([^/]+)\/countdown$/);
    if (req.method === 'POST' && countdownMatch) {
      const store = readStore(); const session = store.sessions[countdownMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (session.state !== 'ENTRY_PAID') return json(res, 409, { error: `Invalid session transition: ${session.state} -> COUNTDOWN` });
      session.state = 'COUNTDOWN'; session.updatedAt = now(); recordTelemetry(store, { type: 'countdown', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty }); writeStore(store); return json(res, 200, { session });
    }

    const beginMatch = path.match(/^\/api\/sessions\/([^/]+)\/begin$/);
    if (req.method === 'POST' && beginMatch) {
      const store = readStore(); const session = store.sessions[beginMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (!['COUNTDOWN', 'ENTRY_PAID'].includes(session.state)) return json(res, 409, { error: `Invalid session transition: ${session.state} -> WAVE_PLAYING` });
      if (session.walletMode === 'PLATFORM') {
        const wallet = session.platformWallet;
        if (!wallet?.holdId) return json(res, 409, { error: 'Platform wallet reservation is missing' });
        if (!wallet.capturedAt) {
          await platform.capture({
            userId: wallet.userId, matchId: wallet.matchId, holdId: wallet.holdId, idempotencyKey: wallet.captureRequestId,
            metadata: { game: 'galaga', sessionId: session.id, difficulty: session.difficulty },
          });
          wallet.capturedAt = now();
        }
        wallet.playStarted = true;
        const player = store.players[session.playerId];
        if (player) await refreshPlatformBalance(player);
      } else if (session.walletMode === 'SIDESIX') {
        session.sideSix.playStarted = true;
      }
      session.state = 'WAVE_PLAYING'; session.waveState = { startCore: coreStart(session), startedAt: now(), lastResult: null };
      session.coreState.waveElapsed = 0; session.coreState.enemiesRemaining = WAVE[session.wave]?.enemies || 0;
      session.updatedAt = now(); recordTelemetry(store, { type: 'wave_begin', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty }); writeStore(store); return json(res, 200, { session, player: store.players[session.playerId] });
    }

    const coreMatch = path.match(/^\/api\/sessions\/([^/]+)\/core-state$/);
    if (req.method === 'POST' && coreMatch) {
      const body = await readBody(req); const store = readStore(); const session = store.sessions[coreMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (session.state !== 'WAVE_PLAYING') return json(res, 409, { error: `Core state cannot update from ${session.state}` });
      const validation = validateIncomingSnapshot(store, session, body, { endpoint: 'core-state' });
      if (!validation.ok && antiCheatEnforced()) { writeStore(store); return json(res, 422, { error: 'Snapshot rejected by server validation', validation: { flags: validation.flags, riskScore: session.antiCheat.riskScore } }); }
      applyCoreSnapshot(session, body); writeStore(store); return json(res, 200, { session, validation: { flags: validation.flags, riskScore: session.antiCheat.riskScore } });
    }

    const clearMatch = path.match(/^\/api\/sessions\/([^/]+)\/wave-clear$/);
    if (req.method === 'POST' && clearMatch) {
      const body = await readBody(req); const store = readStore(); const session = store.sessions[clearMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      const recoveryWallet = walletState(session);
      if (
        isExternalWalletSession(session)
        && recoveryWallet?.settlementStatus === 'pending'
        && recoveryWallet?.pendingCashout?.mode === 'boss_complete'
      ) {
        const settled = await settleBossCompletion(store, session);
        writeStore(store);
        return json(res, 200, {
          player: settled.player,
          session,
          waveResult: session.waveState?.lastResult || null,
          checkpoint: null,
          bossComplete: session.bossComplete,
          recoveredSettlement: true,
        });
      }
      if (session.state !== 'WAVE_PLAYING') return json(res, 409, { error: `Wave cannot clear from ${session.state}` });
      if (Number(body.wave) !== Number(session.wave)) return json(res, 409, { error: 'Wave mismatch' });
      const def = WAVE[session.wave];
      if (!def) return json(res, 409, { error: 'Current gameplay implements Waves 1-10 only' });
      const validation = validateIncomingSnapshot(store, session, body, { endpoint: 'wave-clear', finalizing: true });
      if (!validation.ok && antiCheatEnforced()) { writeStore(store); return json(res, 422, { error: 'Wave clear rejected by server validation', validation: { flags: validation.flags, riskScore: session.antiCheat.riskScore } }); }
      applyCoreSnapshot(session, body);
      const start = session.waveState?.startCore || { score: 0, kills: 0, shotsFired: 0, shotsHit: 0, damageTaken: 0 };
      const waveKills = Math.max(0, session.coreState.kills - nonNegativeInt(start.kills));
      if (waveKills < def.enemies) return json(res, 409, { error: `Wave ${session.wave} not cleared: ${waveKills}/${def.enemies} enemies` });

      const previousCompleted = session.completedWaves || [];
      const previousKillsByType = previousCompleted.length ? previousCompleted[previousCompleted.length - 1].cumulativeKillsByType || {} : {};
      const previousBombKillsByType = previousCompleted.length ? previousCompleted[previousCompleted.length - 1].cumulativeBombKillsByType || {} : {};
      const previousDangerKillsByType = previousCompleted.length ? previousCompleted[previousCompleted.length - 1].cumulativeDangerKillsByType || {} : {};
      const deltaKills = {};
      const deltaBombKills = {};
      const deltaDangerKills = {};
      for (const type of Object.keys(SCORE)) {
        deltaKills[type] = Math.max(0, nonNegativeInt(session.coreState.killsByType[type]) - nonNegativeInt(previousKillsByType[type]));
        deltaBombKills[type] = Math.max(0, nonNegativeInt(session.coreState.bombKillsByType[type]) - nonNegativeInt(previousBombKillsByType[type]));
        const nonBombDelta = Math.max(0, deltaKills[type] - deltaBombKills[type]);
        deltaDangerKills[type] = Math.min(nonBombDelta, Math.max(0, nonNegativeInt(session.coreState.dangerKillsByType?.[type]) - nonNegativeInt(previousDangerKillsByType[type])));
      }
      if (def.final && deltaKills.finalBoss < 1) return json(res, 409, { error: 'Final Boss must be destroyed to complete Wave 10' });

      const waveShots = Math.max(0, session.coreState.shotsFired - nonNegativeInt(start.shotsFired));
      const waveHits = Math.max(0, session.coreState.shotsHit - nonNegativeInt(start.shotsHit));
      const waveDamage = Math.max(0, session.coreState.damageTaken - nonNegativeInt(start.damageTaken));
      const accuracy = waveShots > 0 ? Math.min(100, Math.round((waveHits / waveShots) * 10000) / 100) : 0;
      const scoredDeltaKills = subtractMaps(deltaKills, deltaBombKills);
      const claimedCombat = nonNegativeInt(body.waveResult?.combatScore, 0, 2_000_000);
      const comboMax = comboMaxForDifficulty(session.difficulty);
      const dangerCombatCap = Math.round(scoreBase(deltaDangerKills) * comboMax * 0.25);
      const combatCap = scoreBase(scoredDeltaKills) * comboMax + dangerCombatCap;
      const combatScore = Math.min(claimedCombat, combatCap);
      const rate = accuracyRate(accuracy);
      const accuracyBonus = Math.round(combatScore * rate);
      const perfectBonus = waveDamage === 0 ? 1000 : 0;
      const aceBonus = waveDamage === 0 && accuracy > 90 && waveKills >= def.enemies ? 2500 : 0;
      session.score = nonNegativeInt(start.score) + combatScore + accuracyBonus + perfectBonus + aceBonus;
      const result = {
        wave: session.wave, combatScore, accuracy, accuracyRate: rate, accuracyBonus, perfectBonus, aceBonus,
        waveKills, damageTaken: waveDamage,
        duration: finiteNumber(body.waveResult?.duration, session.coreState.waveElapsed || 0, 0, 240),
        scoreAfterBonuses: session.score,
        cumulativeKillsByType: { ...session.coreState.killsByType },
        cumulativeBombKillsByType: { ...session.coreState.bombKillsByType },
        cumulativeDangerKillsByType: { ...session.coreState.dangerKillsByType }
      };
      session.completedWaves = [...previousCompleted, result];
      session.waveState.lastResult = result;
      session.coreState.comboIndex = 0; session.coreState.comboMultiplier = 1; session.coreState.comboTimer = 0;

      let player = store.players[session.playerId];
      if (def.final) {
        const settled = await settleBossCompletion(store, session);
        player = settled.player;
      } else if (def.checkpoint) {
        session.state = 'CHECKPOINT';
        session.checkpoint = checkpointPayload(session, def);
      } else {
        session.state = 'WAVE_CLEAR';
        session.checkpoint = null;
      }
      session.updatedAt = now();
      recordTelemetry(store, { type: 'wave_clear', playerId: session.playerId, sessionId: session.id, wave: result.wave, difficulty: session.difficulty, data: { score: session.score, accuracy: result.accuracy, duration: result.duration, damageTaken: result.damageTaken, combatScore: result.combatScore } });
      if (session.state === 'CHECKPOINT') recordTelemetry(store, { type: 'checkpoint_reached', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: { score: session.score, currentReward: session.checkpoint?.currentReward, multiplier: session.checkpoint?.currentMultiplier } });
      writeStore(store);
      return json(res, 200, { player, session, waveResult: result, checkpoint: session.checkpoint, bossComplete: session.bossComplete, validation: { flags: validation.flags, riskScore: session.antiCheat?.riskScore || 0 } });
    }

    const nextMatch = path.match(/^\/api\/sessions\/([^/]+)\/next-wave$/);
    if (req.method === 'POST' && nextMatch) {
      const store = readStore(); const session = store.sessions[nextMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (session.state !== 'WAVE_CLEAR') return json(res, 409, { error: `Automatic wave advance cannot run from ${session.state}` });
      if (session.wave >= 10) return json(res, 409, { error: 'Final Boss is the last wave' });
      startNextWave(session); recordTelemetry(store, { type: 'wave_begin', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty }); writeStore(store); return json(res, 200, { session });
    }

    const decisionMatch = path.match(/^\/api\/sessions\/([^/]+)\/checkpoint-decision$/);
    if (req.method === 'POST' && decisionMatch) {
      const body = await readBody(req); const store = readStore(); const session = store.sessions[decisionMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (session.state === 'RESULT') return json(res, 200, { player: store.players[session.playerId], session, autoCashout: session.cashout?.mode === 'auto' });
      if (session.state !== 'CHECKPOINT') return json(res, 409, { error: `Checkpoint decision cannot run from ${session.state}` });
      const action = String(body.action || '').toLowerCase();

      // Explicit player input wins the checkpoint race when it reaches the server
      // before an AUTO request has actually settled the session. Previously the
      // server checked the wall-clock deadline first, so a legitimate Continue
      // click near the deadline could be converted into an automatic cashout.
      if (action === 'continue') {
        if (session.wave >= 10) return json(res, 409, { error: 'Final Boss is the last wave' });
        session.checkpointHistory ||= [];
        session.checkpointHistory.push({ ...session.checkpoint, decision: 'CONTINUE', decidedAt: now() });
        recordTelemetry(store, { type: 'checkpoint_continue', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: { score: session.score } });
        startNextWave(session); recordTelemetry(store, { type: 'wave_begin', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty }); writeStore(store);
        return json(res, 200, { player: store.players[session.playerId], session, autoCashout: false });
      }

      if (await autoSettleExpiredCheckpoint(store, session)) {
        writeStore(store);
        return json(res, 200, { player: store.players[session.playerId], session, autoCashout: true });
      }
      if (action === 'cashout' || action === 'auto') {
        const auto = action === 'auto';
        const payload = await settleCashout(store, session, auto ? 'auto' : 'manual'); writeStore(store);
        return json(res, 200, { ...payload, autoCashout: auto });
      }
      return json(res, 400, { error: 'Decision must be cashout, auto, or continue' });
    }

    const closeMatch = path.match(/^\/api\/sessions\/([^/]+)\/close$/);
    if (req.method === 'POST' && closeMatch) {
      const store = readStore(); const session = store.sessions[closeMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (!['RESULT', 'RUN_LOST', 'BOSS_COMPLETE'].includes(session.state)) return json(res, 409, { error: `Cannot close active session from ${session.state}` });
      const player = store.players[session.playerId];
      if (player?.activeSessionId === session.id) player.activeSessionId = null;
      session.closedAt = now(); session.updatedAt = now(); recordTelemetry(store, { type: 'session_close', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: { state: session.state, reward: session.reward, score: session.score } }); writeStore(store);
      return json(res, 200, { player, session });
    }

    const loseMatch = path.match(/^\/api\/sessions\/([^/]+)\/lose$/);
    if (req.method === 'POST' && loseMatch) {
      const body = await readBody(req); const store = readStore(); const session = store.sessions[loseMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (session.state === 'RUN_LOST') return json(res, 200, { player: store.players[session.playerId], session });
      if (session.state !== 'WAVE_PLAYING') return json(res, 409, { error: `Run cannot be lost from ${session.state}` });
      const loseBody = { ...body, damageTaken: 3 };
      const validation = validateIncomingSnapshot(store, session, loseBody, { endpoint: 'run-lost' });
      if (!validation.ok && antiCheatEnforced()) { writeStore(store); return json(res, 422, { error: 'Run-lost snapshot rejected by server validation', validation: { flags: validation.flags, riskScore: session.antiCheat.riskScore } }); }
      applyCoreSnapshot(session, loseBody);
      session.state = 'RUN_LOST'; session.lives = 0; session.reward = 0; session.updatedAt = now();
      const player = store.players[session.playerId]; if (player?.activeSessionId === session.id) player.activeSessionId = null;
      transaction(store, { playerId: session.playerId, sessionId: session.id, type: 'RUN_LOST_SETTLEMENT', amount: 0, balanceAfter: player?.balance ?? 0, meta: { wave: session.wave, score: session.score } });
      recordTelemetry(store, { type: 'run_lost', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: { score: session.score, damageTaken: session.coreState?.damageTaken || 3 } });
      writeStore(store); return json(res, 200, { player, session });
    }

    const abandonMatch = path.match(/^\/api\/sessions\/([^/]+)\/abandon$/);
    if (req.method === 'POST' && abandonMatch) {
      const store = readStore(); const session = store.sessions[abandonMatch[1]];
      if (!session) return json(res, 404, { error: 'Session not found' });
      assertSessionOwnership(session, platformIdentity);
      if (['RESULT', 'RUN_LOST', 'BOSS_COMPLETE'].includes(session.state)) return json(res, 409, { error: 'Session already finished' });
      const refunded = await cancelUnstartedExternalRun(store, session, 'game_failed');
      session.state = 'RUN_LOST'; session.reward = 0; session.updatedAt = now();
      if (refunded) session.cancelledBeforePlay = true;
      const player = store.players[session.playerId]; if (player?.activeSessionId === session.id) player.activeSessionId = null;
      if (session.walletMode === 'PLATFORM' && player) await refreshPlatformBalance(player);
      transaction(store, { playerId: session.playerId, sessionId: session.id, type: 'ABANDON_SETTLEMENT', amount: 0, balanceAfter: player?.balance ?? 0, meta: { wave: session.wave, score: session.score } });
      recordTelemetry(store, { type: 'run_abandon', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: { score: session.score } });
      writeStore(store); return json(res, 200, { player, session });
    }

    if (req.method === 'POST' && path === '/api/dev/reset' && process.env.NODE_ENV !== 'production') {
      const store = readStore();
      store.players['demo-player'] = { id: 'demo-player', displayName: 'STARBLAST', balance: 5000, activeSessionId: null };
      store.sessions = {}; store.transactions = []; store.telemetry = { version: 1, events: [] }; writeStore(store);
      return json(res, 200, { ok: true, player: store.players['demo-player'] });
    }

    return json(res, 404, { error: 'Route not found' });
  } catch (error) {
    console.error(error);
    const status = Number(error?.statusCode || error?.status || 500);
    const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    const publicMessage = safeStatus >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : (error.message || 'Internal server error');
    return json(res, safeStatus, { error: publicMessage, code: error?.code || 'REQUEST_FAILED' });
  }
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) server.listen(PORT, '0.0.0.0', () => console.log(`Galaga Skill Wager BE listening on http://0.0.0.0:${PORT}`));

export { server, readStore, writeStore, coreStart, defaultCore, WAVE, CHECKPOINTS, SCORE, DIFFICULTY_ECONOMY, economyForDifficulty, startMultiplierForDifficulty, scoreGateForDifficulty, checkpointMultiplierForDifficulty, comboMaxForDifficulty, checkpointsForDifficulty, checkpointPayload, buildSettlement, unlockedTier };

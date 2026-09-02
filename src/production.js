const SCORE_TYPES = ['fighter', 'diver', 'shooter', 'heavy', 'charger', 'elite', 'miniBoss', 'finalBoss'];

export const BOSS_HP_BY_DIFFICULTY = Object.freeze({
  easy: Object.freeze({ miniBoss: 75, finalBoss: 150 }),
  medium: Object.freeze({ miniBoss: 110, finalBoss: 220 }),
  hard: Object.freeze({ miniBoss: 160, finalBoss: 320 })
});

export function bossHpForDifficulty(type, difficulty = 'medium') {
  const table = BOSS_HP_BY_DIFFICULTY[String(difficulty || '').toLowerCase()] || BOSS_HP_BY_DIFFICULTY.medium;
  return Math.max(1, Number(table[type] || (type === 'miniBoss' ? 110 : 220)));
}

export const PHASE8_TARGETS = Object.freeze({
  survivalPercent: Object.freeze({ 1: 97, 2: 90, 3: 78, 4: 66, 5: 52, 6: 42, 7: 31, 8: 22, 9: 14, 10: 7 }),
  economyReturnPercent: Object.freeze({ min: 94, max: 96 }),
  runLengthSeconds: Object.freeze({ min: 240, max: 360 }),
  waveTargetSeconds: Object.freeze({ min: 35, max: 45 })
});

export const WAVE_MIX = Object.freeze({
  1: Object.freeze({ fighter: 8, diver: 2, shooter: 2 }),
  2: Object.freeze({ fighter: 8, diver: 5, shooter: 3 }),
  3: Object.freeze({ fighter: 7, diver: 7, shooter: 4 }),
  4: Object.freeze({ fighter: 6, diver: 8, shooter: 6 }),
  5: Object.freeze({ miniBoss: 1 }),
  6: Object.freeze({ fighter: 5, diver: 6, shooter: 4, heavy: 3, charger: 2 }),
  7: Object.freeze({ fighter: 4, diver: 6, shooter: 6, heavy: 3, charger: 3 }),
  8: Object.freeze({ fighter: 12, diver: 7, shooter: 4, charger: 2 }),
  9: Object.freeze({ fighter: 4, diver: 4, shooter: 4, heavy: 4, charger: 3, elite: 3 }),
  10: Object.freeze({ finalBoss: 1 })
});

export const WAVE_PATTERNS = Object.freeze({
  1: Object.freeze(['singleDive']),
  2: Object.freeze(['singleDive', 'twinDive']),
  3: Object.freeze(['singleDive', 'twinDive', 'zigzag']),
  4: Object.freeze(['singleDive', 'twinDive', 'zigzag', 'pincer']),
  5: Object.freeze([]),
  6: Object.freeze(['spiral', 'singleDive', 'charge']),
  7: Object.freeze(['crossfire', 'pincer', 'twinDive', 'charge']),
  8: Object.freeze(['swarm', 'zigzag', 'twinDive', 'charge']),
  9: Object.freeze(['eliteAssault', 'crossfire', 'pincer', 'charge', 'spiral']),
  10: Object.freeze([])
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const nonNegative = (value, fallback = 0) => Math.max(0, finite(value, fallback));
const countMap = (value = {}) => Object.fromEntries(SCORE_TYPES.map((key) => [key, Math.max(0, Math.floor(finite(value?.[key], 0)))]));
const deltaMap = (current = {}, start = {}) => Object.fromEntries(SCORE_TYPES.map((key) => [key, Math.max(0, finite(current?.[key], 0) - finite(start?.[key], 0))]));
const sumMap = (map = {}) => Object.values(map).reduce((sum, value) => sum + nonNegative(value), 0);

export function ensurePhase8Store(store) {
  store.schemaVersion = Math.max(8, Number(store.schemaVersion || 0));
  store.players ||= {};
  store.sessions ||= {};
  store.transactions ||= [];
  store.telemetry ||= {};
  store.telemetry.events ||= [];
  store.telemetry.version = 1;
  return store;
}

export function recordTelemetry(store, event) {
  ensurePhase8Store(store);
  const row = {
    id: String(event.id || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`),
    type: String(event.type || 'unknown'),
    playerId: event.playerId ? String(event.playerId) : null,
    sessionId: event.sessionId ? String(event.sessionId) : null,
    wave: event.wave == null ? null : Math.max(0, Math.floor(finite(event.wave))),
    difficulty: event.difficulty ? String(event.difficulty) : null,
    data: event.data && typeof event.data === 'object' ? event.data : {},
    createdAt: event.createdAt || new Date().toISOString()
  };
  store.telemetry.events.push(row);
  const maxEvents = Math.max(1000, Math.min(100000, Number(process.env.TELEMETRY_MAX_EVENTS || 20000)));
  if (store.telemetry.events.length > maxEvents) store.telemetry.events.splice(0, store.telemetry.events.length - maxEvents);
  return row;
}

function addFlag(flags, code, severity, details = {}) {
  flags.push({ code, severity, details });
}

function waveAllowedKillCaps(wave, elapsed) {
  // Gameplay Patch 4: Wave 10 is a strict solo Final Boss encounter.
  // No summoned fighters or regular-enemy farming is valid in the final wave.
  return { ...countMap(WAVE_MIX[wave] || {}) };
}

export function validateCoreSnapshot(session, body, { finalizing = false } = {}) {
  const flags = [];
  const wave = Number(session?.wave || body?.wave || 1);
  const previous = session?.coreState || {};
  const start = session?.waveState?.startCore || {};
  const elapsed = nonNegative(body?.waveElapsed, nonNegative(previous.waveElapsed));
  const previousElapsed = nonNegative(previous.waveElapsed);
  const elapsedDelta = Math.max(0, elapsed - previousElapsed);
  const wallStarted = Date.parse(session?.waveState?.startedAt || session?.updatedAt || session?.createdAt || '');
  const wallElapsed = Number.isFinite(wallStarted) ? Math.max(0, (Date.now() - wallStarted) / 1000) : elapsed;

  if (Number(body?.wave || wave) !== wave) addFlag(flags, 'wave_mismatch', 'severe', { expected: wave, received: body?.wave });
  if (elapsed + 0.25 < previousElapsed) addFlag(flags, 'client_clock_rewind', 'severe', { previousElapsed, elapsed });
  if (elapsed > wallElapsed * 1.8 + 6) addFlag(flags, 'client_clock_ahead', 'medium', { wallElapsed: Math.round(wallElapsed * 100) / 100, elapsed });

  const startShots = nonNegative(start.shotsFired);
  const currentShots = nonNegative(body?.shotsFired, nonNegative(previous.shotsFired));
  const waveShots = Math.max(0, currentShots - startShots);
  const maxWaveShots = Math.ceil(elapsed * 16 + 18); // covers double-shot Overdrive + network slack.
  if (waveShots > maxWaveShots) addFlag(flags, 'impossible_fire_rate', 'severe', { waveShots, maxWaveShots, elapsed });

  const startHits = nonNegative(start.shotsHit);
  const currentHits = nonNegative(body?.shotsHit, nonNegative(previous.shotsHit));
  const waveHits = Math.max(0, currentHits - startHits);
  if (waveHits > waveShots * 2 + 4) addFlag(flags, 'impossible_hit_rate', 'severe', { waveHits, waveShots });

  const startKills = countMap(start.killsByType || {});
  const requestedKills = countMap(body?.killsByType || previous.killsByType || {});
  const waveKills = deltaMap(requestedKills, startKills);
  const killCaps = waveAllowedKillCaps(wave, elapsed);
  for (const type of SCORE_TYPES) {
    const cap = nonNegative(killCaps[type]);
    if (waveKills[type] > cap) addFlag(flags, 'impossible_enemy_type_count', 'severe', { type, count: waveKills[type], cap, wave });
  }

  const totalKillCap = sumMap(killCaps);
  const totalWaveKills = sumMap(waveKills);
  if (totalWaveKills > totalKillCap) addFlag(flags, 'impossible_kill_count', 'severe', { totalWaveKills, totalKillCap, wave });

  const requestedBomb = countMap(body?.bombKillsByType || previous.bombKillsByType || {});
  const startBomb = countMap(start.bombKillsByType || {});
  const waveBomb = deltaMap(requestedBomb, startBomb);
  if (sumMap(waveBomb) > totalKillCap) addFlag(flags, 'impossible_bomb_kills', 'severe', { bombKills: sumMap(waveBomb), totalKillCap });
  if (sumMap(waveBomb) > 0 && body?.bombUsed !== true && previous?.bombUsed !== true) addFlag(flags, 'bomb_kills_without_bomb', 'severe', { bombKills: sumMap(waveBomb) });

  const requestedDanger = countMap(body?.dangerKillsByType || previous.dangerKillsByType || {});
  const startDanger = countMap(start.dangerKillsByType || {});
  const waveDanger = deltaMap(requestedDanger, startDanger);
  for (const type of SCORE_TYPES) {
    const nonBombKills = Math.max(0, nonNegative(waveKills[type]) - nonNegative(waveBomb[type]));
    const cap = ['miniBoss', 'finalBoss'].includes(type) ? 0 : nonBombKills;
    if (waveDanger[type] > cap) addFlag(flags, 'impossible_danger_kill_count', 'severe', { type, count: waveDanger[type], cap, wave });
  }

  const allowedPatterns = new Set(WAVE_PATTERNS[wave] || []);
  const previousPatterns = start.patternActivations || {};
  const currentPatterns = body?.patternActivations || previous.patternActivations || {};
  for (const [pattern, rawCount] of Object.entries(currentPatterns)) {
    const increment = Math.max(0, nonNegative(rawCount) - nonNegative(previousPatterns?.[pattern]));
    if (increment > 0 && !allowedPatterns.has(pattern)) addFlag(flags, 'pattern_not_allowed_in_wave', 'medium', { pattern, increment, wave });
  }

  const damage = nonNegative(body?.damageTaken, nonNegative(previous.damageTaken));
  if (damage > 3) addFlag(flags, 'impossible_damage_count', 'severe', { damage });

  if (wave === 5) {
    const expectedHp = bossHpForDifficulty('miniBoss', session?.difficulty || 'medium');
    const maxHp = nonNegative(body?.miniBossMaxHp, nonNegative(previous.miniBossMaxHp));
    const hp = nonNegative(body?.miniBossHp, nonNegative(previous.miniBossHp));
    if (maxHp && maxHp !== expectedHp) addFlag(flags, 'mini_boss_hp_schema_mismatch', 'medium', { maxHp, expectedHp, difficulty: session?.difficulty || 'medium' });
    if (hp > expectedHp) addFlag(flags, 'mini_boss_hp_impossible', 'severe', { hp, expectedHp, difficulty: session?.difficulty || 'medium' });
    if (nonNegative(previous.miniBossHp) > 0 && hp > nonNegative(previous.miniBossHp)) addFlag(flags, 'mini_boss_hp_increased', 'severe', { previous: previous.miniBossHp, hp });
  } else if (nonNegative(body?.miniBossHp) > 0) {
    addFlag(flags, 'mini_boss_outside_wave_5', 'medium', { wave });
  }

  if (wave === 10) {
    const expectedHp = bossHpForDifficulty('finalBoss', session?.difficulty || 'medium');
    const maxHp = nonNegative(body?.finalBossMaxHp, nonNegative(previous.finalBossMaxHp));
    const hp = nonNegative(body?.finalBossHp, nonNegative(previous.finalBossHp));
    if (maxHp && maxHp !== expectedHp) addFlag(flags, 'final_boss_hp_schema_mismatch', 'medium', { maxHp, expectedHp, difficulty: session?.difficulty || 'medium' });
    if (hp > expectedHp) addFlag(flags, 'final_boss_hp_impossible', 'severe', { hp, expectedHp, difficulty: session?.difficulty || 'medium' });
    if (nonNegative(previous.finalBossHp) > 0 && hp > nonNegative(previous.finalBossHp)) addFlag(flags, 'final_boss_hp_increased', 'severe', { previous: previous.finalBossHp, hp });
  } else if (nonNegative(body?.finalBossHp) > 0) {
    addFlag(flags, 'final_boss_outside_wave_10', 'medium', { wave });
  }

  if (finalizing) {
    const minSeconds = wave === 10 ? 10.0 : wave === 5 ? 8.0 : 2.0;
    if (elapsed < minSeconds) addFlag(flags, 'impossible_wave_completion_time', 'severe', { elapsed, minSeconds, wave });
  }

  const severe = flags.filter((flag) => flag.severity === 'severe');
  const medium = flags.filter((flag) => flag.severity === 'medium');
  const riskDelta = severe.length * 40 + medium.length * 10;
  return { ok: severe.length === 0, flags, severe, medium, riskDelta, metrics: { wave, elapsed, elapsedDelta, wallElapsed, waveShots, waveHits, totalWaveKills } };
}

export function applyValidationResult(store, session, result, { endpoint = 'core-state' } = {}) {
  session.antiCheat ||= { riskScore: 0, flags: [], rejectedSnapshots: 0, reviewed: false };
  session.antiCheat.riskScore = Math.min(1000, nonNegative(session.antiCheat.riskScore) + nonNegative(result.riskDelta));
  session.antiCheat.lastCheckedAt = new Date().toISOString();
  if (result.flags.length) {
    for (const flag of result.flags) {
      const row = { ...flag, endpoint, wave: session.wave, createdAt: new Date().toISOString() };
      session.antiCheat.flags.push(row);
      recordTelemetry(store, { type: 'validation_flag', playerId: session.playerId, sessionId: session.id, wave: session.wave, difficulty: session.difficulty, data: row });
    }
    if (session.antiCheat.flags.length > 100) session.antiCheat.flags.splice(0, session.antiCheat.flags.length - 100);
  }
  if (!result.ok) session.antiCheat.rejectedSnapshots = nonNegative(session.antiCheat.rejectedSnapshots) + 1;
  session.antiCheat.reviewRequired = session.antiCheat.riskScore >= 80 || session.antiCheat.rejectedSnapshots >= 2;
  return session.antiCheat;
}

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
};
const average = (values) => values.length ? values.reduce((sum, value) => sum + finite(value), 0) / values.length : 0;

export function buildTelemetrySummary(store) {
  ensurePhase8Store(store);
  const sessions = Object.values(store.sessions || {});
  const totalRuns = sessions.length;
  const completedRuns = sessions.filter((s) => ['RESULT', 'RUN_LOST', 'BOSS_COMPLETE'].includes(s.state) || s.closedAt).length;
  const bossReached = sessions.filter((s) => Number(s.wave || 0) >= 10).length;
  const bossKilled = sessions.filter((s) => (s.completedWaves || []).some((w) => Number(w.wave) === 10)).length;
  const totalEntry = sessions.reduce((sum, s) => sum + nonNegative(s.entryAmount), 0);
  const totalReward = sessions.reduce((sum, s) => sum + nonNegative(s.reward), 0);
  const returnPercent = totalEntry > 0 ? totalReward / totalEntry * 100 : 0;

  const survival = {};
  for (let wave = 1; wave <= 10; wave += 1) {
    const cleared = sessions.filter((s) => (s.completedWaves || []).some((row) => Number(row.wave) === wave)).length;
    const actual = totalRuns > 0 ? cleared / totalRuns * 100 : 0;
    survival[wave] = {
      cleared,
      actualPercent: round(actual),
      targetPercent: PHASE8_TARGETS.survivalPercent[wave],
      deltaPercent: round(actual - PHASE8_TARGETS.survivalPercent[wave])
    };
  }

  const difficulty = { easy: 0, medium: 0, hard: 0 };
  const cashoutByWave = {};
  for (const session of sessions) {
    if (session.difficulty in difficulty) difficulty[session.difficulty] += 1;
    if (session.cashoutWave != null) cashoutByWave[session.cashoutWave] = (cashoutByWave[session.cashoutWave] || 0) + 1;
  }

  const accuracies = sessions.map((s) => {
    const fired = nonNegative(s.coreState?.shotsFired);
    const hit = nonNegative(s.coreState?.shotsHit);
    return fired > 0 ? Math.min(100, hit / fired * 100) : 0;
  });
  const durations = sessions.map((s) => (s.completedWaves || []).reduce((sum, row) => sum + nonNegative(row.duration), 0));
  const flagged = sessions.filter((s) => nonNegative(s.antiCheat?.riskScore) > 0).length;
  const reviewRequired = sessions.filter((s) => s.antiCheat?.reviewRequired).length;

  return {
    generatedAt: new Date().toISOString(),
    runs: {
      total: totalRuns,
      completed: completedRuns,
      bossReached,
      bossKilled,
      averageFinalWave: round(average(sessions.map((s) => Number(s.wave || 0)))),
      averageScore: round(average(sessions.map((s) => Number(s.score || 0)))),
      averageAccuracyPercent: round(average(accuracies)),
      averagePlayDurationSeconds: round(average(durations))
    },
    economy: {
      totalEntryCoins: totalEntry,
      totalRewardCoins: totalReward,
      returnPercent: round(returnPercent),
      targetReturnPercent: PHASE8_TARGETS.economyReturnPercent,
      withinTarget: totalEntry > 0 && returnPercent >= PHASE8_TARGETS.economyReturnPercent.min && returnPercent <= PHASE8_TARGETS.economyReturnPercent.max
    },
    survivalByWave: survival,
    cashoutByWave,
    difficulty,
    antiCheat: { flaggedSessions: flagged, reviewRequiredSessions: reviewRequired },
    telemetryEvents: store.telemetry.events.length
  };
}

export function buildBalanceReport(store) {
  const summary = buildTelemetrySummary(store);
  const survivalWarnings = Object.entries(summary.survivalByWave)
    .filter(([, row]) => Math.abs(row.deltaPercent) >= 8)
    .map(([wave, row]) => ({ wave: Number(wave), actualPercent: row.actualPercent, targetPercent: row.targetPercent, deltaPercent: row.deltaPercent }));
  let economyStatus = 'NO_DATA';
  if (summary.economy.totalEntryCoins > 0) {
    economyStatus = summary.economy.withinTarget ? 'ON_TARGET' : summary.economy.returnPercent < PHASE8_TARGETS.economyReturnPercent.min ? 'RETURN_LOW' : 'RETURN_HIGH';
  }
  return {
    generatedAt: summary.generatedAt,
    sampleSize: summary.runs.total,
    minimumRecommendedPlaytests: 100,
    dataConfidence: summary.runs.total >= 100 ? 'PLAYTEST_BASELINE' : summary.runs.total >= 30 ? 'EARLY_SIGNAL' : 'INSUFFICIENT_SAMPLE',
    economyStatus,
    economy: summary.economy,
    survivalWarnings,
    survivalByWave: summary.survivalByWave,
    note: 'Phase 8 reports deviations; it does not silently rebalance score gates, payouts, or difficulty without playtest evidence.'
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoreSnapshot, buildTelemetrySummary, ensurePhase8Store, PHASE8_TARGETS } from '../src/production.js';

const zeroTypes = () => ({ fighter: 0, diver: 0, shooter: 0, heavy: 0, charger: 0, elite: 0, miniBoss: 0, finalBoss: 0 });
const zeroPatterns = () => ({ singleDive: 0, twinDive: 0, zigzag: 0, pincer: 0, swarm: 0, crossfire: 0, spiral: 0, charge: 0, eliteAssault: 0 });

function sessionForWave(wave = 1) {
  const killsByType = zeroTypes();
  const bombKillsByType = zeroTypes();
  const patternActivations = zeroPatterns();
  return {
    id: 's1', playerId: 'p1', wave, difficulty: 'medium', createdAt: new Date(Date.now() - 15000).toISOString(),
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    coreState: { shotsFired: 0, shotsHit: 0, damageTaken: 0, killsByType, bombKillsByType, patternActivations, waveElapsed: 0, bombUsed: false },
    waveState: { startedAt: new Date(Date.now() - 12000).toISOString(), startCore: { shotsFired: 0, shotsHit: 0, damageTaken: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), patternActivations: zeroPatterns() } }
  };
}

test('normal Wave 1 snapshot is accepted', () => {
  const session = sessionForWave(1);
  const body = {
    wave: 1, waveElapsed: 10, shotsFired: 45, shotsHit: 12, damageTaken: 0,
    killsByType: { ...zeroTypes(), fighter: 4, diver: 1 }, bombKillsByType: zeroTypes(),
    patternActivations: { ...zeroPatterns(), singleDive: 2 }, bombUsed: false
  };
  const result = validateCoreSnapshot(session, body);
  assert.equal(result.ok, true);
  assert.equal(result.severe.length, 0);
});

test('impossible fire rate is rejected', () => {
  const session = sessionForWave(1);
  const body = { wave: 1, waveElapsed: 1, shotsFired: 1000, shotsHit: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), patternActivations: zeroPatterns() };
  const result = validateCoreSnapshot(session, body);
  assert.equal(result.ok, false);
  assert.ok(result.severe.some((flag) => flag.code === 'impossible_fire_rate'));
});

test('enemy type farming outside a wave mix is rejected', () => {
  const session = sessionForWave(1);
  const body = {
    wave: 1, waveElapsed: 10, shotsFired: 20, shotsHit: 10,
    killsByType: { ...zeroTypes(), elite: 1 }, bombKillsByType: zeroTypes(), patternActivations: zeroPatterns()
  };
  const result = validateCoreSnapshot(session, body);
  assert.equal(result.ok, false);
  assert.ok(result.severe.some((flag) => flag.code === 'impossible_enemy_type_count' && flag.details.type === 'elite'));
});

test('telemetry summary reports economy and survival against design targets', () => {
  const store = ensurePhase8Store({
    players: {}, transactions: [], telemetry: { events: [] },
    sessions: {
      a: { state: 'RESULT', wave: 3, entryAmount: 100, reward: 110, score: 20000, difficulty: 'easy', completedWaves: [{ wave: 1, duration: 40 }, { wave: 2, duration: 40 }, { wave: 3, duration: 40 }], coreState: { shotsFired: 100, shotsHit: 90 } },
      b: { state: 'RUN_LOST', wave: 1, entryAmount: 100, reward: 0, score: 1000, difficulty: 'hard', completedWaves: [], coreState: { shotsFired: 20, shotsHit: 10 }, antiCheat: { riskScore: 40 } }
    }
  });
  const summary = buildTelemetrySummary(store);
  assert.equal(summary.runs.total, 2);
  assert.equal(summary.economy.totalEntryCoins, 200);
  assert.equal(summary.economy.totalRewardCoins, 110);
  assert.equal(summary.survivalByWave[1].cleared, 1);
  assert.equal(summary.survivalByWave[10].targetPercent, PHASE8_TARGETS.survivalPercent[10]);
  assert.equal(summary.antiCheat.flaggedSessions, 1);
});

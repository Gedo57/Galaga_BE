import test from 'node:test';
import assert from 'node:assert/strict';
import { BOSS_HP_BY_DIFFICULTY, bossHpForDifficulty, validateCoreSnapshot } from '../src/production.js';

const zeroTypes = () => ({ fighter: 0, diver: 0, shooter: 0, heavy: 0, charger: 0, elite: 0, miniBoss: 0, finalBoss: 0 });
const baseSession = (wave, difficulty, hpKey, hp) => {
  const startedAt = new Date(Date.now() - 35_000).toISOString();
  return {
    wave, difficulty, createdAt: startedAt, updatedAt: new Date().toISOString(),
    coreState: {
      waveElapsed: 20, shotsFired: 80, shotsHit: 50, damageTaken: 0,
      killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), patternActivations: {},
      [hpKey]: hp,
      [`${hpKey.replace('Hp', '')}MaxHp`]: hp
    },
    waveState: { startedAt, startCore: { shotsFired: 0, shotsHit: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), patternActivations: {} } }
  };
};

test('difficulty boss HP table matches combat rebuild', () => {
  assert.deepEqual(BOSS_HP_BY_DIFFICULTY.easy, { miniBoss: 75, finalBoss: 150 });
  assert.deepEqual(BOSS_HP_BY_DIFFICULTY.medium, { miniBoss: 110, finalBoss: 220 });
  assert.deepEqual(BOSS_HP_BY_DIFFICULTY.hard, { miniBoss: 160, finalBoss: 320 });
  assert.equal(bossHpForDifficulty('miniBoss', 'hard'), 160);
  assert.equal(bossHpForDifficulty('finalBoss', 'easy'), 150);
});

test('hard Mini Boss accepts 160 max HP schema', () => {
  const session = baseSession(5, 'hard', 'miniBossHp', 160);
  const result = validateCoreSnapshot(session, { wave: 5, waveElapsed: 24, shotsFired: 100, shotsHit: 65, damageTaken: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), miniBossHp: 120, miniBossMaxHp: 160, patternActivations: {} });
  assert.equal(result.ok, true, JSON.stringify(result.flags));
  assert.equal(result.flags.some((f) => f.code === 'mini_boss_hp_schema_mismatch'), false);
});

test('easy Final Boss rejects HP above 150', () => {
  const session = baseSession(10, 'easy', 'finalBossHp', 150);
  const result = validateCoreSnapshot(session, { wave: 10, waveElapsed: 28, shotsFired: 100, shotsHit: 60, damageTaken: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), finalBossHp: 151, finalBossMaxHp: 150, finalBossPhase: 1, patternActivations: {} });
  assert.equal(result.ok, false);
  assert.ok(result.flags.some((f) => f.code === 'final_boss_hp_impossible'));
});

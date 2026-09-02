import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoreSnapshot, WAVE_MIX, WAVE_PATTERNS } from '../src/production.js';

const zeroTypes = () => ({ fighter: 0, diver: 0, shooter: 0, heavy: 0, charger: 0, elite: 0, miniBoss: 0, finalBoss: 0 });

function wave10Session() {
  const startedAt = new Date(Date.now() - 35_000).toISOString();
  return {
    wave: 10,
    difficulty: 'medium',
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    coreState: {
      waveElapsed: 25,
      shotsFired: 70,
      shotsHit: 45,
      killsByType: zeroTypes(),
      bombKillsByType: zeroTypes(),
      damageTaken: 0,
      finalBossHp: 220,
      finalBossMaxHp: 220,
      finalBossPhase: 1
    },
    waveState: {
      startedAt,
      startCore: {
        shotsFired: 0,
        shotsHit: 0,
        killsByType: zeroTypes(),
        bombKillsByType: zeroTypes(),
        patternActivations: {}
      }
    }
  };
}

test('Wave 10 is a strict solo Final Boss schema', () => {
  assert.deepEqual(WAVE_MIX[10], { finalBoss: 1 });
  assert.deepEqual(WAVE_PATTERNS[10], []);
});

test('220 HP medium solo Final Boss clear snapshot is accepted', () => {
  const result = validateCoreSnapshot(wave10Session(), {
    wave: 10,
    waveElapsed: 35,
    shotsFired: 110,
    shotsHit: 90,
    killsByType: { ...zeroTypes(), finalBoss: 1 },
    bombKillsByType: zeroTypes(),
    damageTaken: 0,
    finalBossHp: 0,
    finalBossMaxHp: 220,
    finalBossPhase: 3,
    patternActivations: {}
  }, { finalizing: true });
  assert.equal(result.ok, true, JSON.stringify(result.flags));
});

test('regular enemy kill during Wave 10 is rejected', () => {
  const result = validateCoreSnapshot(wave10Session(), {
    wave: 10,
    waveElapsed: 35,
    shotsFired: 110,
    shotsHit: 90,
    killsByType: { ...zeroTypes(), finalBoss: 1, fighter: 1 },
    bombKillsByType: zeroTypes(),
    damageTaken: 0,
    finalBossHp: 0,
    finalBossMaxHp: 220,
    finalBossPhase: 3,
    patternActivations: {}
  }, { finalizing: true });
  assert.equal(result.ok, false);
  assert.ok(result.flags.some((flag) => flag.code === 'impossible_enemy_type_count'));
});

test('Final Boss HP above medium cap is rejected', () => {
  const result = validateCoreSnapshot(wave10Session(), {
    wave: 10,
    waveElapsed: 28,
    shotsFired: 80,
    shotsHit: 50,
    killsByType: zeroTypes(),
    bombKillsByType: zeroTypes(),
    damageTaken: 0,
    finalBossHp: 221,
    finalBossMaxHp: 220,
    finalBossPhase: 1,
    patternActivations: {}
  });
  assert.equal(result.ok, false);
  assert.ok(result.flags.some((flag) => flag.code === 'final_boss_hp_impossible'));
});

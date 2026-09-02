import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoreSnapshot, WAVE_MIX, WAVE_PATTERNS } from '../src/production.js';

const zeroTypes = () => ({ fighter: 0, diver: 0, shooter: 0, heavy: 0, charger: 0, elite: 0, miniBoss: 0, finalBoss: 0 });

function wave5Session() {
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  return {
    wave: 5,
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    coreState: {
      waveElapsed: 10,
      shotsFired: 20,
      shotsHit: 12,
      killsByType: zeroTypes(),
      bombKillsByType: zeroTypes(),
      damageTaken: 0,
      miniBossHp: 110,
      miniBossMaxHp: 110
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

test('Wave 5 is a solo Mini Boss schema', () => {
  assert.deepEqual(WAVE_MIX[5], { miniBoss: 1 });
  assert.deepEqual(WAVE_PATTERNS[5], []);
});

test('110 HP medium solo Mini Boss clear snapshot is accepted', () => {
  const result = validateCoreSnapshot(wave5Session(), {
    wave: 5,
    waveElapsed: 20,
    shotsFired: 45,
    shotsHit: 30,
    killsByType: { ...zeroTypes(), miniBoss: 1 },
    bombKillsByType: zeroTypes(),
    damageTaken: 0,
    miniBossHp: 0,
    miniBossMaxHp: 110,
    patternActivations: {}
  }, { finalizing: true });
  assert.equal(result.ok, true, JSON.stringify(result.flags));
});

test('regular enemy kill during Wave 5 is rejected', () => {
  const result = validateCoreSnapshot(wave5Session(), {
    wave: 5,
    waveElapsed: 20,
    shotsFired: 45,
    shotsHit: 30,
    killsByType: { ...zeroTypes(), miniBoss: 1, fighter: 1 },
    bombKillsByType: zeroTypes(),
    damageTaken: 0,
    miniBossHp: 0,
    miniBossMaxHp: 110,
    patternActivations: {}
  }, { finalizing: true });
  assert.equal(result.ok, false);
  assert.ok(result.flags.some((flag) => flag.code === 'impossible_enemy_type_count'));
});

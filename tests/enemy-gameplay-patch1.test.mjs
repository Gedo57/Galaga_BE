import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoreSnapshot } from '../src/production.js';

const zeroTypes = () => ({ fighter: 0, diver: 0, shooter: 0, heavy: 0, charger: 0, elite: 0, miniBoss: 0, finalBoss: 0 });
const zeroPatterns = () => ({ singleDive: 0, twinDive: 0, zigzag: 0, pincer: 0, swarm: 0, crossfire: 0, spiral: 0, charge: 0, eliteAssault: 0 });
function wave1Session() {
  const startedAt = new Date(Date.now() - 15_000).toISOString();
  return { wave: 1, difficulty: 'medium', createdAt: startedAt, updatedAt: new Date().toISOString(), coreState: { waveElapsed: 5, shotsFired: 10, shotsHit: 3, damageTaken: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), patternActivations: zeroPatterns(), bombUsed: false }, waveState: { startedAt, startCore: { shotsFired: 0, shotsHit: 0, damageTaken: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), patternActivations: zeroPatterns() } } };
}

test('danger kills may be a subset of legitimate non-bomb kills', () => {
  const result = validateCoreSnapshot(wave1Session(), { wave: 1, waveElapsed: 10, shotsFired: 30, shotsHit: 8, damageTaken: 0, killsByType: { ...zeroTypes(), fighter: 2, diver: 1 }, bombKillsByType: zeroTypes(), dangerKillsByType: { ...zeroTypes(), diver: 1 }, patternActivations: { ...zeroPatterns(), singleDive: 1 }, bombUsed: false });
  assert.equal(result.ok, true, JSON.stringify(result.flags));
});

test('danger kills cannot exceed non-bomb kills', () => {
  const result = validateCoreSnapshot(wave1Session(), { wave: 1, waveElapsed: 10, shotsFired: 30, shotsHit: 8, damageTaken: 0, killsByType: { ...zeroTypes(), diver: 1 }, bombKillsByType: zeroTypes(), dangerKillsByType: { ...zeroTypes(), diver: 2 }, patternActivations: { ...zeroPatterns(), singleDive: 1 }, bombUsed: false });
  assert.equal(result.ok, false);
  assert.ok(result.flags.some((flag) => flag.code === 'impossible_danger_kill_count'));
});

test('boss kills cannot receive danger bonus', () => {
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const session = { wave: 10, difficulty: 'medium', createdAt: startedAt, updatedAt: new Date().toISOString(), coreState: { waveElapsed: 20, shotsFired: 60, shotsHit: 40, damageTaken: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), patternActivations: zeroPatterns(), finalBossHp: 220, finalBossMaxHp: 220 }, waveState: { startedAt, startCore: { shotsFired: 0, shotsHit: 0, killsByType: zeroTypes(), bombKillsByType: zeroTypes(), dangerKillsByType: zeroTypes(), patternActivations: zeroPatterns() } } };
  const result = validateCoreSnapshot(session, { wave: 10, waveElapsed: 30, shotsFired: 100, shotsHit: 75, damageTaken: 0, killsByType: { ...zeroTypes(), finalBoss: 1 }, bombKillsByType: zeroTypes(), dangerKillsByType: { ...zeroTypes(), finalBoss: 1 }, finalBossHp: 0, finalBossMaxHp: 220, finalBossPhase: 3, patternActivations: zeroPatterns() }, { finalizing: true });
  assert.equal(result.ok, false);
  assert.ok(result.flags.some((flag) => flag.code === 'impossible_danger_kill_count'));
});

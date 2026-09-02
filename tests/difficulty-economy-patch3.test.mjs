import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTY_ECONOMY as BE_ECONOMY,
  checkpointsForDifficulty,
  comboMaxForDifficulty,
  scoreGateForDifficulty,
  checkpointMultiplierForDifficulty
} from '../src/server.js';
import {
  DIFFICULTY_ECONOMY as FE_ECONOMY,
  comboStepsForDifficulty,
  comboWindowForDifficulty,
  startMultiplierForDifficulty,
  scoreGateForDifficulty as feScoreGate,
  checkpointMultiplierForDifficulty as feCheckpointMultiplier
} from '../../FE/src/waveConfig.js';

const expected = {
  easy: {
    startMultiplier: 1.5,
    comboWindow: 2.5,
    comboMax: 2,
    scoreGates: { 3: 15300, 5: 35700, 7: 63750, 9: 97750, 10: 127500 },
    multipliers: { 3: 1.8, 5: 2.2, 7: 2.7, 9: 3.3, 10: 4 }
  },
  medium: {
    startMultiplier: 2.25,
    comboWindow: 1.8,
    comboMax: 3,
    scoreGates: { 3: 18000, 5: 42000, 7: 75000, 9: 115000, 10: 150000 },
    multipliers: { 3: 2.75, 5: 3.4, 7: 4.2, 9: 5.2, 10: 6.25 }
  },
  hard: {
    startMultiplier: 4,
    comboWindow: 1.25,
    comboMax: 4,
    scoreGates: { 3: 21600, 5: 50400, 7: 90000, 9: 138000, 10: 180000 },
    multipliers: { 3: 4.8, 5: 5.8, 7: 7, 9: 8.5, 10: 10 }
  }
};

test('Patch 3 FE and BE economy tables stay authoritative and identical', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.equal(FE_ECONOMY[difficulty].startMultiplier, expected[difficulty].startMultiplier);
    assert.equal(BE_ECONOMY[difficulty].startMultiplier, expected[difficulty].startMultiplier);
    assert.equal(comboWindowForDifficulty(difficulty), expected[difficulty].comboWindow);
    assert.equal(BE_ECONOMY[difficulty].comboWindow, expected[difficulty].comboWindow);
    assert.equal(Math.max(...comboStepsForDifficulty(difficulty)), expected[difficulty].comboMax);
    assert.equal(comboMaxForDifficulty(difficulty), expected[difficulty].comboMax);
    assert.deepEqual(FE_ECONOMY[difficulty].scoreGates, expected[difficulty].scoreGates);
    assert.deepEqual(BE_ECONOMY[difficulty].scoreGates, expected[difficulty].scoreGates);
    assert.deepEqual(FE_ECONOMY[difficulty].checkpointMultipliers, expected[difficulty].multipliers);
    assert.deepEqual(BE_ECONOMY[difficulty].checkpointMultipliers, expected[difficulty].multipliers);
  }
});

test('cashout checkpoints remain W3/W5/W7/W9 with W10 final payout', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const rows = checkpointsForDifficulty(difficulty);
    assert.deepEqual(rows.map((row) => row.wave), [3, 5, 7, 9, 10]);
    assert.equal(rows[0].multiplier, expected[difficulty].multipliers[3]);
    assert.equal(rows.at(-1).multiplier, expected[difficulty].multipliers[10]);
  }
});

test('difficulty gates and multipliers resolve identically in FE and BE', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.equal(startMultiplierForDifficulty(difficulty), expected[difficulty].startMultiplier);
    for (const wave of [3, 5, 7, 9, 10]) {
      assert.equal(scoreGateForDifficulty(wave, difficulty), expected[difficulty].scoreGates[wave]);
      assert.equal(feScoreGate(wave, difficulty), expected[difficulty].scoreGates[wave]);
      assert.equal(checkpointMultiplierForDifficulty(wave, difficulty), expected[difficulty].multipliers[wave]);
      assert.equal(feCheckpointMultiplier(wave, difficulty), expected[difficulty].multipliers[wave]);
    }
  }
});

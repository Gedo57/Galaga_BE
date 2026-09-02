import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSettlement, checkpointPayload, unlockedTier, startMultiplierForDifficulty } from '../src/server.js';

const cases = [
  ['easy', 1.5],
  ['medium', 2.25],
  ['hard', 4]
];

for (const [difficulty, startMultiplier] of cases) {
  test(`${difficulty}: W3 cashout below score gate uses Start Multiplier floor`, () => {
    const session = { wave: 3, score: 0, difficulty, entryAmount: 100 };
    const tier = unlockedTier(session);
    assert.equal(tier, null);
    assert.equal(startMultiplierForDifficulty(difficulty), startMultiplier);

    const checkpoint = checkpointPayload(session, {});
    assert.equal(checkpoint.bestUnlockedWave, null);
    assert.equal(checkpoint.bestUnlockedMultiplier, startMultiplier);
    assert.equal(checkpoint.currentReward, Math.round(100 * startMultiplier));
    assert.equal(checkpoint.payoutSource, 'start');

    const settlement = buildSettlement(session, tier, 'manual');
    assert.equal(settlement.multiplier, startMultiplier);
    assert.equal(settlement.reward, Math.round(100 * startMultiplier));
    assert.equal(settlement.payoutSource, 'start');
  });
}

test('unlocked checkpoint tier still overrides the Start Multiplier floor', () => {
  const session = { wave: 3, score: 18000, difficulty: 'medium', entryAmount: 100 };
  const tier = unlockedTier(session);
  assert.equal(tier.wave, 3);
  assert.equal(tier.multiplier, 2.75);
  const settlement = buildSettlement(session, tier, 'manual');
  assert.equal(settlement.multiplier, 2.75);
  assert.equal(settlement.reward, 275);
  assert.equal(settlement.payoutSource, 'checkpoint');
});

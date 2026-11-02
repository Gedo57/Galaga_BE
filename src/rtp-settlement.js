/**
 * Galaga REAL monetary payout formula, shared by checkpoint previews and
 * actual local/external settlement.
 *
 * The result must be earned through the existing wave gameplay. A sandbox
 * multiplier cannot select enemy hits, alter player survival or hide odds.
 */
export function calculateGalagaSettlementReward(session,multiplier){
  const entryAmount=Number(session?.entryAmount);
  if(!Number.isSafeInteger(entryAmount)||entryAmount<1||
     typeof multiplier!=='number'||!Number.isFinite(multiplier)||multiplier<0)
    throw new RangeError('GALAGA_RTP97_INVALID_PAYOUT_INPUT');
  const scale=session?.rtpConfig?.applied===true?session.rtpConfig.scale:1;
  if(typeof scale!=='number'||!Number.isFinite(scale)||scale<=0||scale>1.2)
    throw new RangeError('GALAGA_RTP97_INVALID_FROZEN_SCALE');
  const product=entryAmount*multiplier*scale;
  if(!Number.isFinite(product)||product>Number.MAX_SAFE_INTEGER-1)
    throw new RangeError('GALAGA_RTP97_PAYOUT_OVERFLOW');
  const reward=Math.round(product);
  if(!Number.isSafeInteger(reward)||reward<0)
    throw new RangeError('GALAGA_RTP97_INVALID_REWARD');
  return Object.freeze({
    reward,payoutScale:scale,
    sandboxCalibrated:session?.rtpConfig?.source==='GALAGA_ISOLATED_TEST_ONLY',
    payoutModel:session?.rtpConfig?.model??'BASE_GALAGA_MULTIPLIER'
  });
}

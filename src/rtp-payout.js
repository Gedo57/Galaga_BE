/** Deterministic per-round payout scale. Not certified/guaranteed RTP.
 * Never changes the skill outcomes, the original multipliers, or past rounds.
 */
export function freezePayoutTarget(snapshot, {productionWallet=false}={}){
 const enabled=productionWallet!==true && snapshot?.applied===true &&
   Number.isInteger(snapshot?.targetRtpBps) && snapshot.targetRtpBps>=100 &&
   snapshot.targetRtpBps<=9900 && Number.isSafeInteger(snapshot?.revision) &&
   snapshot.revision>=0;
 const targetRtpBps=enabled?snapshot.targetRtpBps:9700;
 return Object.freeze({
   targetRtpBps,revision:enabled?snapshot.revision:0,
   applied:enabled,scale:enabled?targetRtpBps/9700:1,
   model:'FROZEN_PAYOUT_SCALE_NOT_CERTIFIED_RTP'
 });
}

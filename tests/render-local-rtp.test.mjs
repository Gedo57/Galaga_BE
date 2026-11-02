import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderRtpClient} from '../src/provider-rtp-target.js';
import {freezePayoutTarget} from '../src/rtp-payout.js';
import {calculateGalagaSettlementReward} from '../src/rtp-settlement.js';

const config=createProviderRtpClient({env:{GAME_RTP_LOCAL_DEMO_ENABLED:'true',GAME_RTP_TARGET_BPS:'9400'}});

test('Render standalone demo target is opt-in, bounded and isolated from Provider API',async()=>{
 const baseline=createProviderRtpClient({env:{GAME_RTP_TARGET_BPS:'9400'}});
 assert.equal(baseline.localDemoEnabled,false);
 assert.equal(baseline.localSnapshot().applied,false);
 assert.equal(config.localDemoEnabled,true);
 assert.deepEqual(config.localSnapshot(),{targetRtpBps:9400,revision:0,source:'RENDER_LOCAL_DEMO',applied:true});
 assert.equal((await config.snapshot()).applied,false);
 assert.equal((await config.snapshot()).targetRtpBps,9700);
 for(const invalid of ['','0','99','9901','10000','97.5','invalid'])
   assert.throws(()=>createProviderRtpClient({env:{GAME_RTP_LOCAL_DEMO_ENABLED:'true',GAME_RTP_TARGET_BPS:invalid}}),e=>e.code==='LOCAL_RTP_TARGET_INVALID');
});

test('Render demo target reaches the authoritative game payout/pot formula',()=>{
 const base=calculateGalagaSettlementReward({entryAmount:100},2).reward;
 const less=calculateGalagaSettlementReward({entryAmount:100,rtpConfig:freezePayoutTarget(config.localSnapshot())},2).reward;
 assert.ok(less<base);
});

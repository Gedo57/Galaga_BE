import test from 'node:test';
import assert from 'node:assert/strict';
import {freezePayoutTarget} from '../src/rtp-payout.js';

test('default 97% scale does not change original payout',()=>{
  const x=freezePayoutTarget(null);
  assert.equal(x.scale,1);assert.equal(x.applied,false);
  assert.equal(x.targetRtpBps,9700);
});
test('a trusted target is frozen by new rounds only',()=>{
  const old=freezePayoutTarget({targetRtpBps:9400,revision:4,applied:true});
  const changed=freezePayoutTarget({targetRtpBps:9800,revision:5,applied:true});
  assert.equal(old.targetRtpBps,9400);assert.equal(old.revision,4);
  assert.ok(Math.abs(old.scale-9400/9700)<1e-10);
  assert.equal(changed.revision,5);assert.equal(changed.targetRtpBps,9800);
  assert.equal(old.revision,4);
  assert.equal(Object.isFrozen(old),true);
});
test('production wallets and malformed targets cannot alter payout',()=>{
  assert.equal(freezePayoutTarget({targetRtpBps:9400,revision:7,applied:true},{productionWallet:true}).scale,1);
  assert.equal(freezePayoutTarget({targetRtpBps:0,revision:7,applied:true}).scale,1);
  assert.equal(freezePayoutTarget({targetRtpBps:10000,revision:7,applied:true}).scale,1);
  assert.equal(freezePayoutTarget({targetRtpBps:9400,revision:-3,applied:true}).scale,1);
});
test('Galaga fixed multiplier reward is scaled once for the next session',()=>{
  const original=Math.round(100*2.2);
  const configured=Math.round(100*2.2*freezePayoutTarget({targetRtpBps:9400,revision:3,applied:true}).scale);
  assert.equal(original,220);assert.equal(configured,Math.round(220*9400/9700));
});

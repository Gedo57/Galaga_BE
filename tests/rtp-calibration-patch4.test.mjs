import test from 'node:test';
import assert from 'node:assert/strict';
import {DIFFICULTY_ECONOMY,buildSettlement,unlockedTier} from '../src/server.js';
import {GALAGA_QA_RULES,galagaBaselineReward,galagaHypotheticalReward,
  calibrateGalagaQaRuns} from '../src/rtp-calibration.js';

function row(i,{difficulty='easy',wave=5,state='CASHOUT',score=35700,
  entryAmount=100,walletMode='PROVIDER',policyId='skill-standard'}={}) {
  const r={runId:'qa-galaga-'+String(i).padStart(8,'0'),rulesVersion:GALAGA_QA_RULES,
    policyId,difficulty,walletMode,state,wave,score,entryAmount,reward:0,
    source:'SANDBOX_QA',settlementStatus:'CONFIRMED',rtpApplied:false,refunded:false};
  r.reward=galagaBaselineReward(r).reward;
  return r;
}

test('source authoritative multipliers and score gates used without a duplicate payout table',()=>{
  for(const difficulty of ['easy','medium','hard']){
    const game=DIFFICULTY_ECONOMY[difficulty];
    const r=row(0,{difficulty,score:0});
    const model=galagaBaselineReward(r);
    assert.equal(model.multiplier,game.startMultiplier);
    assert.equal(model.reward,Math.round(100*game.startMultiplier));
    const gate=row(1,{difficulty,score:game.scoreGates[5]});
    assert.equal(galagaBaselineReward(gate).multiplier,game.checkpointMultipliers[5]);
    assert.equal(galagaBaselineReward(gate).reward,
      buildSettlement(gate,unlockedTier(gate),'manual').reward);
  }
});

test('losses pay zero, boss completion uses last unlocked gate and half-up coin rounding',()=>{
  assert.equal(galagaBaselineReward(row(0,{state:'RUN_LOST',wave:8})).reward,0);
  const complete=row(1,{difficulty:'hard',state:'BOSS_COMPLETE',wave:10,score:180000});
  assert.equal(galagaBaselineReward(complete).multiplier,10);
  assert.equal(galagaHypotheticalReward(complete,1),1000);
  assert.equal(galagaHypotheticalReward(row(2,{score:0}),0.5),75);
  assert.throws(()=>galagaBaselineReward(row(4,{state:'CASHOUT',wave:7})),
    /INVALID_TERMINAL_WAVE/);
});

test('a 97 percent cash flow in finite fake samples is never certified',()=>{
  const out=calibrateGalagaQaRuns([]);
  assert.equal(out.status,'NO_SETTLED_QA_DATA');
  assert.equal(out.certified,false);
  assert.equal(out.segments.length,0);
});

test('optimizer estimates a downward-only provisional factor against settled win/loss policies',()=>{
  const rows=Array.from({length:500},(_,i)=>row(i,{state:i%5===0?'RUN_LOST':'CASHOUT'}));
  const report=calibrateGalagaQaRuns(rows,{minTraining:80,minHoldout:15});
  const c=report.segments[0];
  assert.equal(report.totalSubmittedRows,500);
  assert.equal(c.rounds,500);
  assert.ok(c.baselineCashFlowRtp>0.97);
  assert.ok(c.candidateScale>0&&c.candidateScale<1);
  assert.ok(c.candidateTrainingRtp>0.85&&c.candidateTrainingRtp<1.1);
  assert.equal(c.certified,false);
  assert.equal(c.eligibleForActivation,false);
  assert.equal(rows[0].reward,0);
  assert.equal(rows[1].reward,220);
});

test('insufficient samples, separate skills and wallet modes do not mix',()=>{
  const data=[
    row(0),row(1,{difficulty:'medium',score:42000}),
    row(2,{walletMode:'LOCAL'}),row(3,{policyId:'skill-expert'})
  ];
  const res=calibrateGalagaQaRuns(data,{minTraining:1,minHoldout:1});
  assert.equal(res.segments.length,4);
  assert.ok(res.segments.every(x=>x.status==='INSUFFICIENT_SAMPLE'));
});

test('below-target baseline cannot reach 97 percent without raising original payouts',()=>{
  const data=Array.from({length:500},(_,i)=>row(i,{state:i%10===0?'CASHOUT':'RUN_LOST'}));
  const c=calibrateGalagaQaRuns(data,{minTraining:80,minHoldout:15}).segments[0];
  assert.equal(c.status,'BELOW_TARGET_AT_CURRENT_PAYOUT_CEILING');
  assert.equal(c.candidateScale,null);
});

test('reject duplicates, pending bets, refunds, player identifiers, altered payouts and scaled runs',()=>{
  const normal=row(0);
  const invalid=[
    {...normal,source:'BROWSER'},
    {...normal,settlementStatus:'PENDING'},
    {...normal,rtpApplied:true},
    {...normal,refunded:true},
    {...normal,playerId:'PRIVATE'},
    {...normal,difficulty:'nightmare'},
    {...normal,rulesVersion:'invented'},
    {...normal,score:-1},
    {...normal,reward:normal.reward+1},
    {...normal,policyId:'bad policy'}
  ];
  for(const example of invalid)assert.throws(()=>calibrateGalagaQaRuns([example]),
    /GALAGA_CALIBRATION_/);
  assert.throws(()=>calibrateGalagaQaRuns([normal,normal]),/DUPLICATE_RUN/);
  assert.throws(()=>calibrateGalagaQaRuns([normal],{targetRtp:1.1}),/TARGET_RTP/);
  assert.throws(()=>galagaHypotheticalReward(normal,1.01),/SCALE_NOT_APPROVED/);
});

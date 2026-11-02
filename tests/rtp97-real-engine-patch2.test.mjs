import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const PLAYER_ID='player-rtp97impltest0001';
const temp=mkdtempSync(join(tmpdir(),'galaga-rtp97-impl2-'));
process.env.NODE_ENV='test';
process.env.STORE_PATH=join(temp,'test-wallet.json');
process.env.GALAGA_RTP97_SANDBOX_ACK='FAKE_CREDITS_ONLY';
process.env.GALAGA_RTP97_SANDBOX_ENABLED='true';
const QA_POLICY={
  rulesVersion:'galaga-economy-v0.8.1-unattested',
  difficulty:'medium',
  // Medium low-score payout x2.25; 50 synthetic wins × 194 / 100 × 100 = 97%.
  scale:194/225,
  cohort:'qa-synthetic-half-checkpoint-half-abandon'
};
const configure=(policy=QA_POLICY)=>{
  process.env.GALAGA_RTP97_SANDBOX_ENABLED='true';
  process.env.GALAGA_RTP97_SANDBOX_POLICY_JSON=JSON.stringify(policy);
};
configure();
const {server,readStore,writeStore,buildSettlement,checkpointPayload}=
  await import('../src/server.js');
const {freezeGalagaLocalSandboxPolicy}=
  await import('../src/rtp-sandbox-policy.js');
const {calculateGalagaSettlementReward}=
  await import('../src/rtp-settlement.js');
const {GALAGA_QA_RULES}=await import('../src/rtp-calibration.js');
let base;

before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  rmSync(temp,{recursive:true,force:true});
});

async function request(path,body){
  const res=await fetch(base+path,{
    method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json','X-Client-Version':'0.8.1'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const json=await res.json();
  return {status:res.status,data:json};
}
async function reset(){
  const r=await request('/api/dev/reset',{});
  assert.equal(r.status,200);
  const st=readStore();
  delete st.players[PLAYER_ID];
  writeStore(st);
}
async function start(bet=100){
  const r=await request('/api/sessions/start',{
    playerId:PLAYER_ID,difficulty:'medium',entryAmount:bet});
  assert.equal(r.status,201,JSON.stringify(r.data));
  return r.data;
}
async function fakeCheckpoint(id) {
  // THE GAMEPLAY RESULT IS A SYNTHETIC FIXTURE, NOT A PLAYED WAVE.
  const store=readStore(),session=store.sessions[id];
  session.state='CHECKPOINT';
  session.wave=5;
  session.score=0;
  session.checkpoint=checkpointPayload(session,{enemies:1,checkpoint:true});
  writeStore(store);
}
async function cashout(id){
  const r=await request('/api/sessions/'+id+'/checkpoint-decision',{action:'cashout'});
  assert.equal(r.status,200,JSON.stringify(r.data));
  return r.data;
}
async function abandon(id){
  const r=await request('/api/sessions/'+id+'/abandon',{});
  assert.equal(r.status,200,JSON.stringify(r.data));
  return r.data;
}

test('isolated non-production sandbox policy rejects all external money and unsupported environments',()=>{
  assert.equal(GALAGA_QA_RULES,QA_POLICY.rulesVersion);
  const snapshot=freezeGalagaLocalSandboxPolicy({difficulty:'medium',walletMode:'LOCAL'});
  assert.equal(snapshot.applied,true);
  assert.equal(snapshot.scale,QA_POLICY.scale);
  assert.equal(snapshot.source,'GALAGA_ISOLATED_TEST_ONLY');
  assert.equal(Object.isFrozen(snapshot),true);
  for(const walletMode of ['PROVIDER','PLATFORM','SIDESIX'])
    assert.equal(freezeGalagaLocalSandboxPolicy({difficulty:'medium',walletMode}),null);
  assert.equal(freezeGalagaLocalSandboxPolicy({difficulty:'easy'}),null);
  const old=process.env.NODE_ENV;
  process.env.NODE_ENV='production';
  assert.equal(freezeGalagaLocalSandboxPolicy({difficulty:'medium'}),null);
  process.env.NODE_ENV=old;
});

test('rejects unsafe/stale/undisclosed policy before LOCAL wager is debited',async()=>{
  await reset();
  const orig=process.env.GALAGA_RTP97_SANDBOX_ACK;
  process.env.GALAGA_RTP97_SANDBOX_ACK='no';
  let res=await request('/api/sessions/start',{
    playerId:PLAYER_ID,difficulty:'medium',entryAmount:100});
  assert.notEqual(res.status,201);
  process.env.GALAGA_RTP97_SANDBOX_ACK=orig;
  for(const bad of [
    {...QA_POLICY,rulesVersion:'old'},
    {...QA_POLICY,difficulty:'missing'},
    {...QA_POLICY,scale:0},
    {...QA_POLICY,scale:1.05},
    {...QA_POLICY,playerId:'injected'},
  ]){
    configure(bad);
    res=await request('/api/sessions/start',{
      playerId:PLAYER_ID,difficulty:'medium',entryAmount:100});
    assert.notEqual(res.status,201,JSON.stringify(bad));
  }
  const state=readStore();
  assert.equal(state.players['demo-player'].balance,5000);
  assert.equal(Object.keys(state.sessions).length,0);
  configure();
});

test('actual backend bet→checkpoint decision credits calibrated fake wallet only once',async()=>{
  await reset();
  configure();
  const out=await start();
  assert.equal(out.player.balance,4900);
  assert.equal(out.session.rtpConfig.scale,QA_POLICY.scale);
  const id=out.session.id;
  configure({...QA_POLICY,scale:0.5}); // Future bets can differ, this wager cannot.
  await fakeCheckpoint(id);
  const before=await request('/api/sessions/'+id);
  assert.equal(before.data.session.checkpoint.currentReward,194);
  const resolved=await cashout(id);
  assert.equal(resolved.session.cashout.reward,194);
  assert.equal(resolved.session.cashout.sandboxRtpCalibrationApplied,true);
  assert.equal(resolved.session.cashout.payoutScale,QA_POLICY.scale);
  assert.equal(resolved.player.balance,5094);
  const retries=await cashout(id);
  assert.equal(retries.player.balance,5094);
  assert.equal(readStore().transactions.filter(x=>
    x.sessionId===id&&x.type==='CASHOUT_CREDIT').length,1);
  configure();
});

test('actual backend settlement bookkeeping on 100 synthetic terminal decisions returns 97 percent ONLY for fixture',async()=>{
  await reset();
  configure();
  let betTotal=0,wonTotal=0,winCount=0;
  for(let i=0;i<100;i++){
    const {session,player}=await start();
    assert.equal(session.entryAmount,100);
    const id=session.id;
    betTotal+=100;
    if(i%2===0){
      await fakeCheckpoint(id);
      const settled=await cashout(id);
      assert.equal(settled.session.cashout.reward,194);
      assert.equal(settled.session.cashout.sandboxRtpCalibrationApplied,true);
      wonTotal+=settled.session.cashout.reward;
      winCount++;
    }else{
      const lost=await abandon(id);
      assert.equal(lost.session.state,'RUN_LOST');
      assert.equal(lost.session.reward,0);
    }
  }
  const store=readStore();
  assert.equal(winCount,50);
  assert.equal(betTotal,10000);
  assert.equal(wonTotal,9700);
  assert.equal(wonTotal/betTotal,.97);
  assert.equal(store.players[PLAYER_ID].balance,4700);
  assert.equal(store.transactions.filter(t=>t.type==='ENTRY_DEBIT').length,100);
  assert.equal(store.transactions.filter(t=>t.type==='CASHOUT_CREDIT').length,50);
  // No enemies, waves, bosses or player controls were physically simulated.
  // The 50/50 successes are fabricated solely to exercise settlement math.
});

test('disabled mode keeps unmodified actual baseline, losses pay zero and game math remains authoritative',async()=>{
  await reset();
  process.env.GALAGA_RTP97_SANDBOX_ENABLED='false';
  const {session}=await start();
  assert.equal(session.rtpConfig.scale,1);
  assert.equal(session.rtpConfig.applied,false);
  await fakeCheckpoint(session.id);
  const settled=await cashout(session.id);
  assert.equal(settled.session.cashout.reward,225);
  assert.equal(settled.session.cashout.sandboxRtpCalibrationApplied,false);
  assert.equal(settled.player.balance,5125);
  const model=buildSettlement({entryAmount:100,difficulty:'medium',score:0,wave:5},null,'manual');
  assert.equal(model.reward,225);
  const noLoss=calculateGalagaSettlementReward({entryAmount:100},0);
  assert.equal(noLoss.reward,0);
  configure();
});

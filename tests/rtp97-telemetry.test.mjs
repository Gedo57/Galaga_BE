import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBalanceReport,buildTelemetrySummary,PHASE8_TARGETS} from '../src/production.js';
import {DIFFICULTY_ECONOMY} from '../src/server.js';

const session=(id,state,bet,reward)=>({
 id,state,entryAmount:bet,reward,difficulty:'medium',wave:1,score:0,completedWaves:[],coreState:{},
});

test('97 percent nominal target window is 96..98, not the previous 94..96 range',()=>{
 assert.deepEqual(PHASE8_TARGETS.economyReturnPercent,{min:96,max:98});
});

test('live run with a paid wager is excluded until its loss or payout settles',()=>{
 const store={sessions:{
   settled:session('settled','RESULT',1000,970),
   playing:session('playing','WAVE_PLAYING',5000,0),
 },players:{},transactions:[],telemetry:{events:[]}};
 const r=buildTelemetrySummary(store);
 assert.equal(r.economy.totalEntryCoins,1000);
 assert.equal(r.economy.totalRewardCoins,970);
 assert.equal(r.economy.returnPercent,97);
 assert.equal(r.economy.settledRuns,1);
 assert.equal(r.economy.unsettledRunsExcluded,1);
 assert.equal(r.economy.withinTarget,true);
 assert.equal(r.economy.certified,false);
});

test('failed terminal runs are included rather than misreported as free wagers',()=>{
 const store={sessions:{
   lose:session('lose','RUN_LOST',500,0),
   win:session('win','RESULT',500,970),
   open:session('open','CHECKPOINT',700,0),
 },players:{},transactions:[],telemetry:{events:[]}};
 const r=buildBalanceReport(store);
 assert.equal(r.economy.settledRuns,2);
 assert.equal(r.economy.totalEntryCoins,1000);
 assert.equal(r.economy.totalRewardCoins,970);
 assert.equal(r.economy.returnPercent,97);
 assert.equal(r.economyStatus,'INSUFFICIENT_SAMPLE');
 assert.equal(r.sampleSize,2);
});
test('checkpoint multipliers only give conditional success thresholds, never certified RTP',()=>{
 for(const cfg of Object.values(DIFFICULTY_ECONOMY)){
   for(const m of Object.values(cfg.checkpointMultipliers)){
     const p=0.97/m;
     assert.ok(p>0&&p<1);
     assert.ok(Math.abs(m*p-0.97)<1e-12);
   }
 }
});

test('only 100 settled runs may be flagged on target',()=>{
 const sessions={};
 for(let i=0;i<100;i++)sessions['settled-'+i]=session('settled-'+i,'RESULT',1000,970);
 for(let i=0;i<20;i++)sessions['active-'+i]=session('active-'+i,'WAVE_PLAYING',10000,0);
 const report=buildBalanceReport({sessions,players:{},transactions:[],telemetry:{events:[]}});
 assert.equal(report.sampleSize,100);
 assert.equal(report.openRunsExcluded,20);
 assert.equal(report.economy.returnPercent,97);
 assert.equal(report.economyStatus,'ON_TARGET');
 assert.equal(report.economy.certified,false);
});

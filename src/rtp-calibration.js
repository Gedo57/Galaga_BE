/**
 * RTP97 Patch 4 — Galaga offline, non-enforcing calibration worksheet.
 *
 * Uses the actual authoritative backend economy and settlement formula.
 * It NEVER modifies a run, reward, wallet, random event, or game setting.
 *
 * Current Galaga does NOT persist a trusted rulesVersion, independent physics
 * attestation, complete wallet reconciliation or a per-strategy calibration
 * cohort. All input rows must be independently verified before being treated
 * as evidence; this tool's self-described source flag is NOT such verification.
 */
import { DIFFICULTY_ECONOMY, unlockedTier, buildSettlement } from './server.js';

export const GALAGA_RTP_TARGET=0.97;
export {GALAGA_QA_RULES} from './rtp-calibration-rules.js';
import {GALAGA_QA_RULES} from './rtp-calibration-rules.js';
export const GALAGA_MAX_ROWS=100000;
const ID=/^[A-Za-z0-9._:-]{8,128}$/;
const POLICY=/^[a-z][a-z0-9_-]{3,63}$/;
const MODES=new Set(['LOCAL','PROVIDER','PLATFORM','SIDESIX']);
const OUTCOMES=new Set(['CASHOUT','BOSS_COMPLETE','RUN_LOST']);
const FIELDS=new Set(['runId','rulesVersion','policyId','difficulty','walletMode',
  'state','wave','score','entryAmount','reward','settlementStatus','source','rtpApplied','refunded']);

function fail(code){throw new RangeError('GALAGA_CALIBRATION_'+code);}
const validInteger=x=>Number.isSafeInteger(x)&&x>=0;

/** Uses the exact current Galaga backend settlement function. */
export function galagaBaselineReward({difficulty,wave,score,entryAmount,state}) {
  if(!Object.hasOwn(DIFFICULTY_ECONOMY,difficulty))fail('DIFFICULTY');
  if(!Number.isSafeInteger(wave)||wave<1||wave>10)fail('WAVE');
  if(!validInteger(score)||score>1000000000)fail('SCORE');
  if(!Number.isSafeInteger(entryAmount)||entryAmount<50||entryAmount>1000000||entryAmount%50!==0)
    fail('ENTRY');
  if(!OUTCOMES.has(state))fail('OUTCOME');
  if(state==='RUN_LOST')return Object.freeze({reward:0,multiplier:0,source:'LOSS'});
  if((state==='CASHOUT'&&![5,9].includes(wave))||(state==='BOSS_COMPLETE'&&wave!==10))
    fail('INVALID_TERMINAL_WAVE');
  const session={difficulty,wave,score,entryAmount,rtpConfig:null};
  const tier=unlockedTier(session);
  const settlement=buildSettlement(session,tier,state==='BOSS_COMPLETE'?'boss_complete':'manual');
  if(!Number.isSafeInteger(settlement.reward)||settlement.reward<0)fail('PAYOUT_OVERFLOW');
  return Object.freeze({reward:settlement.reward,multiplier:settlement.multiplier,
    source:settlement.payoutSource,tierWave:settlement.tierWave});
}

export function galagaHypotheticalReward(row,scale) {
  if(typeof scale!=='number'||!Number.isFinite(scale)||scale<0||scale>1)
    fail('SCALE_NOT_APPROVED');
  const b=galagaBaselineReward(row);
  return row.state==='RUN_LOST'?0:Math.round(row.entryAmount*b.multiplier*scale);
}

function validateRow(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_ROW');
  if(Object.keys(input).some(k=>!FIELDS.has(k)))fail('EXTRANEOUS_FIELDS');
  if(typeof input.runId!=='string'||!ID.test(input.runId))fail('RUN_ID');
  if(input.rulesVersion!==GALAGA_QA_RULES)fail('RULES_VERSION');
  if(typeof input.policyId!=='string'||!POLICY.test(input.policyId))fail('POLICY');
  if(!MODES.has(input.walletMode))fail('WALLET_MODE');
  if(input.source!=='SANDBOX_QA'||input.settlementStatus!=='CONFIRMED'||
      input.rtpApplied!==false||input.refunded!==false)
    fail('UNVERIFIED_BASELINE');
  const expected=galagaBaselineReward(input);
  if(!validInteger(input.reward)||input.reward!==expected.reward)
    fail('PAYOUT_DOES_NOT_MATCH_SERVER');
  return Object.freeze({...input});
}

function hashHoldout(id){
  let h=2166136261;
  for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619)>>>0;
  return h%5===0;
}
const sum=(rows,getValue)=>{
  const n=rows.reduce((v,r)=>v+getValue(r),0);
  if(!Number.isSafeInteger(n)||n<0)fail('AMOUNT_OVERFLOW');
  return n;
};
function observed(rows,scale){
  if(!rows.length)return null;
  const stake=sum(rows,r=>r.entryAmount);
  if(!stake)fail('ZERO_WAGER');
  const paid=sum(rows,r=>galagaHypotheticalReward(r,scale));
  return paid/stake;
}
function confidenceInterval(rows,scale) {
  if(rows.length<30)return null;
  const ratio=observed(rows,scale),stake=sum(rows,r=>r.entryAmount);
  let varianceSum=0;
  for(const r of rows){
    const d=galagaHypotheticalReward(r,scale)-ratio*r.entryAmount;
    varianceSum+=d*d;
  }
  const se=Math.sqrt((rows.length/(rows.length-1))*varianceSum)/stake;
  return Object.freeze({lower:Math.max(0,ratio-1.96*se),upper:ratio+1.96*se,
    method:'EXPLORATORY_DELTA_95_NOT_INDEPENDENT_CERTIFICATION'});
}
function chooseScale(training,target){
  const baseline=observed(training,1);
  // Baseline is the permitted maximum payout: never propose a new factor >1.
  // A higher factor may breach approved published multipliers and player rules.
  if(baseline+1e-12<target)return {scale:null,trainingReturn:null,status:'BELOW_TARGET_AT_CURRENT_PAYOUT_CEILING'};
  let low=0,high=1;
  for(let i=0;i<60;i++){
    const mid=(low+high)/2;
    if(observed(training,mid)<target)low=mid;
    else high=mid;
  }
  // Monetary rounding means exactly 97.0000% may be infeasible.
  const choices=[low,high,(low+high)/2];
  choices.sort((a,b)=>Math.abs(observed(training,a)-target)-Math.abs(observed(training,b)-target));
  return {scale:choices[0],trainingReturn:observed(training,choices[0]),status:'PROPOSED_SCALE_ONLY'};
}

export function calibrateGalagaQaRuns(rawRows,{targetRtp=GALAGA_RTP_TARGET,
  minTraining=1000,minHoldout=250}={}) {
  if(!Array.isArray(rawRows)||rawRows.length>GALAGA_MAX_ROWS)fail('INVALID_ROWS');
  if(typeof targetRtp!=='number'||!Number.isFinite(targetRtp)||targetRtp<=0||targetRtp>1)
    fail('TARGET_RTP');
  if(!Number.isSafeInteger(minTraining)||minTraining<1||
     !Number.isSafeInteger(minHoldout)||minHoldout<1)fail('SAMPLE_LIMITS');
  const ids=new Set(),groups=new Map();
  for(const raw of rawRows){
    const row=validateRow(raw);
    if(ids.has(row.runId))fail('DUPLICATE_RUN');
    ids.add(row.runId);
    const key=[row.rulesVersion,row.difficulty,row.policyId,row.walletMode].join('|');
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  const segments=[...groups.entries()].map(([cohort,rows])=>{
    const [rulesVersion,difficulty,policyId,walletMode]=cohort.split('|');
    const training=rows.filter(r=>!hashHoldout(r.runId));
    const holdout=rows.filter(r=>hashHoldout(r.runId));
    const baseline=observed(rows,1);
    const won=rows.filter(r=>r.state!=='RUN_LOST').length;
    const modes=Object.fromEntries([...OUTCOMES].map(x=>[x,rows.filter(r=>r.state===x).length]));
    const r={cohort,rulesVersion,difficulty,policyId,walletMode,rounds:rows.length,
      trainRounds:training.length,holdoutRounds:holdout.length,terminalOutcomeCounts:modes,
      baselineCashFlowRtp:baseline,winningRuns:won,
      candidateScale:null,candidateTrainingRtp:null,candidateHoldoutRtp:null,
      confidence95:null,withinPointOnePercent:false,certified:false,eligibleForActivation:false,
      status:'INSUFFICIENT_SAMPLE'};
    if(training.length<minTraining||holdout.length<minHoldout)return Object.freeze(r);
    const chosen=chooseScale(training,targetRtp);
    if(chosen.scale===null){r.status=chosen.status;return Object.freeze(r);}
    const value=observed(holdout,chosen.scale);
    r.candidateScale=Number(chosen.scale.toPrecision(15));
    r.candidateTrainingRtp=chosen.trainingReturn;
    r.candidateHoldoutRtp=value;
    r.confidence95=confidenceInterval(holdout,chosen.scale);
    r.withinPointOnePercent=Math.abs(value-targetRtp)<=0.001;
    r.status=r.withinPointOnePercent?'HOLDOUT_PROVISIONAL_ON_TARGET_UNCERTIFIED':
      'HOLDOUT_OUTSIDE_POINT_ONE_PERCENT';
    return Object.freeze(r);
  }).sort((a,b)=>a.cohort.localeCompare(b.cohort));
  return Object.freeze({
    patch:'RTP97_PATCH4_GALAGA',game:'galaga',targetRtp,rulesVersion:GALAGA_QA_RULES,
    totalSubmittedRows:rawRows.length,segments,
    status:segments.length?'OFFLINE_SANDBOX_QA_NOT_CERTIFIED':'NO_SETTLED_QA_DATA',
    certified:false,productionEnabled:false,gameplayChanged:false,
    note:'Observed skill and cashout policies affect RTP. A declared SANDBOX_QA source does not prove provenance, wallet settlement, fairness or representative skill mix. Candidates are never applied automatically.'
  });
}

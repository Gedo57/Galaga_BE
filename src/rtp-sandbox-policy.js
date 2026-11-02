/**
 * Galaga RTP implementation patch 2: explicit, per-run frozen LOCAL-only
 * payout-calibration candidate used by the real checkpoint/boss settlement.
 *
 * This is NOT an empirical 97% game return, production switch or RNG change.
 * A QA operator provides a cohort-specific factor. Missing verified player
 * strategy distributions must not be silently invented.
 *
 * Safety: NODE_ENV=test, explicit fake-credit acknowledgment and an isolated
 * STORE_PATH. Provider/Platform/SideSix/production are never eligible.
 */
import {GALAGA_QA_RULES} from './rtp-calibration-rules.js';

export const GALAGA_SANDBOX_POLICY_VERSION='galaga-rtp97-sandbox-calibration-v1';
const FIELDS=new Set(['rulesVersion','difficulty','scale','cohort']);
const TOKEN=/^[a-z0-9][a-z0-9_-]{7,79}$/;
const fail=code=>{throw new RangeError('GALAGA_RTP97_SANDBOX_'+code);};

export function freezeGalagaLocalSandboxPolicy({difficulty,walletMode='LOCAL',env=process.env}={}){
  if(walletMode!=='LOCAL'||env?.NODE_ENV==='production')return null;
  if(env?.GALAGA_RTP97_SANDBOX_ENABLED!=='true')return null;
  if(env.NODE_ENV!=='test'||
     env.GALAGA_RTP97_SANDBOX_ACK!=='FAKE_CREDITS_ONLY'||
     !env.STORE_PATH||
     !/[/\\](tmp|temp|test|tests)[/\\]/i.test(env.STORE_PATH))
    fail('NOT_ISOLATED_FAKE_CREDITS');
  const raw=env.GALAGA_RTP97_SANDBOX_POLICY_JSON;
  if(typeof raw!=='string'||raw.length<2||raw.length>1024)fail('POLICY_REQUIRED');
  let policy;
  try{policy=JSON.parse(raw);}catch{fail('INVALID_JSON');}
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||
     Object.keys(policy).length!==4||
     Object.keys(policy).some(k=>!FIELDS.has(k)))fail('POLICY_SCHEMA');
  if(policy.rulesVersion!==GALAGA_QA_RULES)fail('STALE_RULES_VERSION');
  if(!['easy','medium','hard'].includes(policy.difficulty))fail('DIFFICULTY');
  if(typeof policy.scale!=='number'||!Number.isFinite(policy.scale)||
     policy.scale<=0||policy.scale>1)fail('SCALE_UNAPPROVED');
  if(typeof policy.cohort!=='string'||!TOKEN.test(policy.cohort))fail('COHORT');
  if(policy.difficulty!==difficulty)return null;
  return Object.freeze({
    applied:true,targetRtpBps:9700,revision:1,
    scale:policy.scale,model:'LOCAL_FAKE_CREDIT_QA_FACTOR_NOT_CERTIFIED_RTP',
    source:'GALAGA_ISOLATED_TEST_ONLY',rulesVersion:GALAGA_QA_RULES,
    difficulty,cohort:policy.cohort,
    sandboxPolicyVersion:GALAGA_SANDBOX_POLICY_VERSION,
  });
}

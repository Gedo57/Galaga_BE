/** G Provider production-only backend wallet bridge.
 * Never use this code in a browser. Does not support sandbox fallback.
 * Opt in using GP_GAME_PRODUCTION_MODE=production only after partner UAT.
 */
import {createHmac,randomBytes} from 'node:crypto';
const GAMES=new Set(['pinball','galaga','liars-dice','ship-captain-crew','bomberboy','whack-a-mole','tower-rush']);
const AUTH='https://g-provider-production-auth-free.onrender.com';
const WALLET='https://g-provider-production-wallet-free.onrender.com';
const PLAYER=/^[A-Za-z0-9_.:@-]{1,128}$/,TENANT=/^[a-z0-9][a-z0-9-]{2,63}$/;
const REF=/^[A-Za-z0-9_.:@-]{8,128}$/,SESSION=/^gps_[A-Za-z0-9_-]{43}$/;
const LAUNCH=/^gpl124-[a-f0-9]{40}$/,SECRET=/^[A-Za-z0-9_-]{32,256}$/,KEY=/^[A-Za-z0-9_-]{3,64}$/;
const CURRENCY=/^[A-Z]{3}$/;
const bad=(code,status=503)=>{const e=Error(code);e.code=code;e.status=e.statusCode=status;throw e};
function verifyIdentity(raw,gameId){
 if(!raw||raw.productionWallet!==true||raw.gameId!==gameId||
   !TENANT.test(raw.operatorCode||'')||!PLAYER.test(raw.externalPlayerId||'')||
   !LAUNCH.test(raw.launchId||'')||!SESSION.test(raw.sessionToken||'')||
   !CURRENCY.test(raw.currency||'')||!Number.isInteger(raw.decimals)||
   raw.decimals<0||raw.decimals>3||raw.expiresAt<=Date.now())
  bad('PRODUCTION_WALLET_SESSION_INVALID',401);
 return raw;
}
function minor(amount,digits){
 const n=Number(amount)*10**digits,r=Math.round(n);
 if(!Number.isSafeInteger(r)||r<1||r>2147483647||Math.abs(n-r)>1e-6)
  bad('PRODUCTION_WALLET_AMOUNT_INVALID',400);
 return r;
}
async function parseReply(response){
 let data;
 try{const text=await response.text();if(text.length>8192)throw Error('size');
  data=JSON.parse(text);
 }catch{bad('PRODUCTION_WALLET_OUTCOME_UNKNOWN')}
 if(!response.ok){
  if(response.status===202||response.status>=500)
   bad('PRODUCTION_WALLET_OUTCOME_UNKNOWN');
  bad('PRODUCTION_WALLET_REFUSED',response.status);
 }
 return data;
}
export function createProductionGameWalletBridge({
 gameId,env=process.env,httpFetch=fetch,clock=()=>Date.now(),
 nonce=()=>randomBytes(20).toString('hex')
}={}){
 if(!GAMES.has(gameId))bad('PRODUCTION_GAME_UNKNOWN');
 const enabled=env.GP_GAME_PRODUCTION_MODE==='production';
 function configuration(){
  if(!enabled||env.GP_GAME_PRODUCTION_APPROVED!=='true'||
    env.GP_PRODUCTION_WALLET_ORIGIN!==WALLET||
    env.GP_PRODUCTION_AUTH_ORIGIN!==AUTH||
    !KEY.test(env.GP_PRODUCTION_ADAPTER_KEY_ID||'')||
    !SECRET.test(env.GP_PRODUCTION_ADAPTER_SECRET||'')||
    typeof env.GP_PRODUCTION_AUTH_BRIDGE_KEY!=='string'||
    env.GP_PRODUCTION_AUTH_BRIDGE_KEY.length<48)
   bad('PRODUCTION_GAME_INTEGRATION_NOT_APPROVED');
 }
 async function balanceOrOperation(identity,action,params={}){
  configuration();const i=verifyIdentity(identity,gameId);
  if(!['balance','bet','win','refund','reconcile'].includes(action))
   bad('PRODUCTION_WALLET_ACTION_INVALID',400);
  const req={environment:'production',operatorCode:i.operatorCode,
   gameId,launchId:i.launchId,externalPlayerId:i.externalPlayerId,
   action:action==='reconcile'?params.originalAction:action,currency:i.currency};
  if(action!=='balance'){
   if(!REF.test(params.roundId||'')||!REF.test(params.transactionId||''))
    bad('PRODUCTION_WALLET_REFERENCE_INVALID',400);
   if(!['bet','win','refund'].includes(req.action))
    bad('PRODUCTION_WALLET_ACTION_INVALID',400);
   req.roundId=params.roundId;req.transactionId=params.transactionId;
   req.amountMinor=minor(params.amount,i.decimals);
   if(req.action!=='bet'){
    if(!REF.test(params.betTransactionId||''))bad('PRODUCTION_WALLET_BET_REF_REQUIRED',400);
    req.betTransactionId=params.betTransactionId;
   }
  }
  const body=JSON.stringify({sessionToken:i.sessionToken,walletRequest:req});
  const ts=clock(),n=nonce();
  if(!Number.isSafeInteger(ts)||!REF.test(n||''))bad('PRODUCTION_NONCE_OR_CLOCK_INVALID');
  const signature='sha256='+createHmac('sha256',env.GP_PRODUCTION_ADAPTER_SECRET)
   .update('GPROVIDER-ADAPTER-v1\n'+env.GP_PRODUCTION_ADAPTER_KEY_ID+
    '\n'+ts+'\n'+n+'\n'+body).digest('hex');
  let data;
  try{
   const response=await httpFetch(WALLET+'/api/v1/production/wallet/'+action,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(6500),
    headers:{'Content-Type':'application/json','Accept':'application/json',
     'X-GP-Adapter-Key-Id':env.GP_PRODUCTION_ADAPTER_KEY_ID,
     'X-GP-Adapter-Timestamp':String(ts),'X-GP-Adapter-Nonce':n,
     'X-GP-Adapter-Signature':signature},body});
   data=await parseReply(response);
  }catch(e){if(e?.code)throw e;bad('PRODUCTION_WALLET_OUTCOME_UNKNOWN')}
  if(action==='reconcile'){
   if(!data||!['confirmed','rejected','pending','unknown'].includes(data.status))
    bad('PRODUCTION_RECONCILIATION_INVALID');
   return {status:data.status,transactionId:req.transactionId,
    requiresReconciliation:data.reconciliationRequired===true};
  }
  if(!data||data.status!=='confirmed'||data.operatorCode!==i.operatorCode||
    data.action!==action||(action!=='balance'&&data.transactionId!==req.transactionId))
   bad('PRODUCTION_WALLET_UNCONFIRMED');
  if(action==='balance'){
   if(!Number.isSafeInteger(data.balanceMinor)||data.balanceMinor<0)
    bad('PRODUCTION_WALLET_BALANCE_UNTRUSTED');
   return {currency:i.currency,balanceMinor:data.balanceMinor};
  }
  return {status:'succeeded',transactionId:req.transactionId,
    duplicate:data.duplicate===true};
 }
 async function consumeLaunch(launchToken,exchangeId){
  configuration();
  if(!SESSION.test(launchToken||'')||!LAUNCH.test(exchangeId||''))
   bad('PRODUCTION_LAUNCH_INVALID',400);
  let data;
  try{
   const response=await httpFetch(AUTH+'/api/v1/production/internal/game/consume',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{'Content-Type':'application/json','Accept':'application/json',
     'Authorization':'Bearer '+launchToken,
     'X-GP-Wallet-Verify-Key':env.GP_PRODUCTION_AUTH_BRIDGE_KEY},
    body:JSON.stringify({gameId,launchId:exchangeId})});
   data=await parseReply(response);
  }catch(e){if(e?.code)throw e;bad('PRODUCTION_LAUNCH_UNAVAILABLE')}
  if(data?.verified!==true||data.gameId!==gameId||data.launchId!==exchangeId||
    !TENANT.test(data.operatorCode||'')||!PLAYER.test(data.externalPlayerId||'')||
    !CURRENCY.test(data.currency||'')||!Number.isInteger(data.decimals)||
    data.decimals<0||data.decimals>3||
    !Number.isFinite(Date.parse(data.expiresAt))||Date.parse(data.expiresAt)<=clock())
   bad('PRODUCTION_LAUNCH_IDENTITY_UNTRUSTED');
  const identity=Object.freeze({productionWallet:true,gameId,sessionToken:launchToken,
   operatorCode:data.operatorCode,externalPlayerId:data.externalPlayerId,
   launchId:exchangeId,currency:data.currency,decimals:data.decimals,
   expiresAt:Date.parse(data.expiresAt)});
  // Paid gameplay is refused unless upstream casino signs a verified Balance.
  await balanceOrOperation(identity,'balance');
  return identity;
 }
 return Object.freeze({
  enabled,consumeLaunch,async balance(identity){return balanceOrOperation(identity,'balance')},
  async operation(identity,action,{roundId,amount,transactionId,betTransactionId,originalAction}={}){
   return balanceOrOperation(identity,action,{roundId,amount,transactionId,betTransactionId,originalAction});
  }
 });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createProductionGameWalletBridge} from '../src/production-provider-wallet.js';
const gameId='galaga';
const session='gps_'+'A'.repeat(43),launchId='gpl124-'+'a'.repeat(40);
const secret='T'.repeat(48);
const env={GP_GAME_PRODUCTION_MODE:'production',GP_GAME_PRODUCTION_APPROVED:'true',
 GP_PRODUCTION_WALLET_ORIGIN:'https://g-provider-production-wallet-free.onrender.com',
 GP_PRODUCTION_AUTH_ORIGIN:'https://g-provider-production-auth-free.onrender.com',
 GP_PRODUCTION_ADAPTER_KEY_ID:'game_test_key',GP_PRODUCTION_ADAPTER_SECRET:secret,
 GP_PRODUCTION_AUTH_BRIDGE_KEY:'Z'.repeat(64)};
test('game backend can bind a verified production launch and signed wallet balance',async()=>{
 const calls=[];
 const httpFetch=async(url,options)=>{
  calls.push(url);
  if(url.endsWith('/internal/game/consume')){
   assert.equal(options.headers.Authorization,'Bearer '+session);
   const query=JSON.parse(options.body);
   assert.deepEqual(query,{gameId,launchId});
   return {ok:true,status:200,text:async()=>JSON.stringify({verified:true,gameId,launchId,
    operatorCode:'casino-test',externalPlayerId:'player-test',currency:'USD',
    decimals:2,expiresAt:new Date(Date.now()+300000).toISOString()})};
  }
  const action=url.split('/').at(-1),raw=JSON.parse(options.body);
  const h=options.headers,at=Number(h['X-GP-Adapter-Timestamp']);
  const base='GPROVIDER-ADAPTER-v1\n'+env.GP_PRODUCTION_ADAPTER_KEY_ID+
    '\n'+at+'\n'+h['X-GP-Adapter-Nonce']+'\n'+options.body;
  assert.equal(h['X-GP-Adapter-Signature'],
   'sha256='+createHmac('sha256',secret).update(base).digest('hex'));
  assert.equal(raw.walletRequest.gameId,gameId);
  const reply={action,operatorCode:'casino-test',status:'confirmed',
   ...(action==='balance'?{balanceMinor:4000}:{transactionId:raw.walletRequest.transactionId})};
  return {ok:true,status:200,text:async()=>JSON.stringify(reply)};
 };
 const bridge=createProductionGameWalletBridge({gameId,env,httpFetch});
 const identity=await bridge.consumeLaunch(session,launchId);
 assert.equal(identity.productionWallet,true);
 assert.equal((await bridge.balance(identity)).balanceMinor,4000);
 const settled=await bridge.operation(identity,'bet',{roundId:'round-12345678',
  transactionId:'bet-12345678',amount:1.25});
 assert.equal(settled.status,'succeeded');
 assert.deepEqual(calls.map(x=>x.split('/').at(-1)),['consume','balance','balance','bet']);
});
test('production bridge never falls back to old QA when not approved',async()=>{
 const bridge=createProductionGameWalletBridge({gameId,env:{...env,GP_GAME_PRODUCTION_APPROVED:'false'},
   httpFetch:async()=>{throw Error('MUST_NOT_CALL_REMOTE')}});
 assert.equal(bridge.enabled,true);
 await assert.rejects(bridge.consumeLaunch(session,launchId),
  /PRODUCTION_GAME_INTEGRATION_NOT_APPROVED/);
});
test('production wallet error refuses launch instead of issuing demo credit',async()=>{
 const httpFetch=async(url)=>{
  if(url.endsWith('/consume'))return {ok:true,status:200,text:async()=>JSON.stringify({
   verified:true,gameId,launchId,operatorCode:'casino-test',externalPlayerId:'player-test',
   currency:'USD',decimals:2,expiresAt:new Date(Date.now()+300000).toISOString()})};
  return {ok:false,status:503,text:async()=>JSON.stringify({error:'WALLET_NOT_CERTIFIED'})};
 };
 const bridge=createProductionGameWalletBridge({gameId,env,httpFetch});
 await assert.rejects(bridge.consumeLaunch(session,launchId),
  /PRODUCTION_WALLET_OUTCOME_UNKNOWN/);
});

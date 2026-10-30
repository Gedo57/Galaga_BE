import test from 'node:test';
import assert from 'node:assert/strict';
process.env.GAME_PROVIDER_GALAGA_ENABLED='true';
process.env.GAME_PROVIDER_GALAGA_QA_MODE='true';
process.env.GAME_PROVIDER_API_URL='https://g-provider-preproduction-sso-free.onrender.com';
process.env.GAME_PROVIDER_GALAGA_ADAPTER_KEY='A'.repeat(52);
const list=[];
const prior=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{
 list.push({url,opts});
 const path=String(url).split('/').slice(-2).join('/');
 let data;
 if(path==='launch/consume')data={
  gameId:'galaga',integratorId:'p109-operator',externalPlayerId:'qa-actual-player-01',
  launchId:'p109-launch-abcdefghijklmnop',walletSandboxAvailable:true,
  wallet:{currency:'USD',decimals:2}
 };
 else if(path==='wallet/balance')data={currency:'USD',balanceMinor:100000};
 else if(['wallet/bet','wallet/win','wallet/refund'].includes(path))data={
  status:'succeeded',transactionId:JSON.parse(opts.body).transactionId};
 else throw Error('Unexpected '+url);
 return new Response(JSON.stringify({ok:true,data}),{status:200});
};
const {gameProvider}=await import('../src/game-provider.js');
test('P109 Galaga BE calls only P99 QA gateway with server adapter header',async()=>{
 try{
  const user=await gameProvider.consumeLaunch({launchToken:'T'.repeat(43),
   exchangeId:'exchange-0123456789'});
  assert.equal(user.provider,'PROVIDER');
  assert.equal(user.userId,'qa-actual-player-01');
  assert.deepEqual(await gameProvider.getBalance(user),{available:1000,currency:'USD'});
  const bet=gameProvider.requestId('bet',user.launchId,'game-run-12345');
  assert.equal((await gameProvider.operation(user,'bet',{
   runId:'game-run-12345',amount:50,transactionId:bet})).status,'succeeded');
  assert.equal((await gameProvider.operation(user,'refund',{
   runId:'game-run-12345',amount:50,
   transactionId:gameProvider.requestId('refund',user.launchId,'game-run-12345'),betTransactionId:bet})).status,'succeeded');
  assert.equal((await gameProvider.operation(user,'win',{
   runId:'another-game-12345',amount:100,
   transactionId:gameProvider.requestId('win',user.launchId,'another-game-12345'),betTransactionId:bet})).status,'succeeded');
  assert.equal(list.length,5);
  assert.ok(list.every(x=>x.url.startsWith(
   'https://g-provider-preproduction-sso-free.onrender.com/api/v1/preprod/galaga/')));
  assert.ok(list.every(x=>x.opts.headers['X-Game-Adapter-Key']==='A'.repeat(52)));
  assert.ok(list.every(x=>x.opts.redirect==='error'));
 }finally{globalThis.fetch=prior;}
});


import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderRtpClient} from '../src/provider-rtp-target.js';

test('default bridge never applies a target or calls a remote service',async()=>{
  const client=createProviderRtpClient({env:{},fetcher:()=>{throw Error('unexpected network request');}});
  assert.equal(client.enabled,false);
  assert.deepEqual(await client.snapshot(),{targetRtpBps:9700,revision:0,source:'LOCAL_DEFAULT',applied:false});
});
test('authenticated read returns a revisioned target from the provider backend',async()=>{
  const key='X'.repeat(43);
  const calls=[];
  const client=createProviderRtpClient({env:{NODE_ENV:'test',GAME_PROVIDER_RTP_ENABLED:'true',
    GAME_PROVIDER_RTP_API_URL:'https://provider.example',GAME_PROVIDER_RTP_ADAPTER_KEY:key},
    fetcher:async(url,opts)=>{
      calls.push({url,opts});
      return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,
        data:{gameId:"galaga",targetRtpBps:9450,revision:3,verifiedGameAdapter:true,effectiveFrom:'NEXT_NEW_ROUND'}})};
    }});
  assert.deepEqual(await client.snapshot(),{targetRtpBps:9450,revision:3,source:'G_PROVIDER',applied:true});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://provider.example/api/v1/adapter/rtp/galaga');
  assert.equal(calls[0].opts.method,'GET');
  assert.equal(calls[0].opts.headers['X-Game-Adapter-Key'],key);
  assert.equal(calls[0].opts.redirect,'error');
});
test('enabled bridge fails closed on bad credentials or malformed provider response',async()=>{
  const env={GAME_PROVIDER_RTP_ENABLED:'true',GAME_PROVIDER_RTP_API_URL:'https://provider.example',
    GAME_PROVIDER_RTP_ADAPTER_KEY:'X'.repeat(43)};
  const client=createProviderRtpClient({env,fetcher:async()=>({ok:true,
    status:200,text:async()=>JSON.stringify({ok:true,data:{gameId:'other',targetRtpBps:9700,revision:0}})})});
  await assert.rejects(client.snapshot(),e=>e.code==='PROVIDER_RTP_RESPONSE_INVALID'&&e.status===503);
  const noKey=createProviderRtpClient({env:{...env,GAME_PROVIDER_RTP_ADAPTER_KEY:''},
    fetcher:()=>{throw Error('network must not happen');}});
  await assert.rejects(noKey.snapshot(),e=>e.code==='PROVIDER_RTP_NOT_CONFIGURED');
});

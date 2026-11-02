/** Trusted server-to-server RTP target snapshot for NEW provider rounds only. */
const GAME_ID="galaga";
const KEY_ENV="GAME_PROVIDER_GALAGA_ADAPTER_KEY";
const DEFAULT=Object.freeze({targetRtpBps:9700,revision:0,source:'LOCAL_DEFAULT',applied:false});

function unavailable(code){
 const e=new Error(code);e.code=code;e.status=e.statusCode=503;return e;
}
export function createProviderRtpClient({env=process.env,fetcher=globalThis.fetch}={}){
 const enabled=env.GAME_PROVIDER_RTP_ENABLED==='true';
 // Explicit Render setting applies only to standalone fake-credit LOCAL rounds.
 // The GProvider API remains authoritative for Provider-backed rounds.
 const localDemoEnabled=env.GAME_RTP_LOCAL_DEMO_ENABLED==='true';
 const localRaw=String(env.GAME_RTP_TARGET_BPS??'');
 const localTargetBps=Number(localRaw);
 if(localDemoEnabled && (!/^[0-9]{3,4}$/.test(localRaw) ||
   !Number.isSafeInteger(localTargetBps) || localTargetBps<100 || localTargetBps>9900))
   throw unavailable('LOCAL_RTP_TARGET_INVALID');
 const base=String(env.GAME_PROVIDER_RTP_API_URL||'').trim().replace(/\/+$/,'');
 const key=String(env.GAME_PROVIDER_RTP_ADAPTER_KEY||env[KEY_ENV]||'').trim();
 return Object.freeze({
  get enabled(){return enabled;},
  get localDemoEnabled(){return localDemoEnabled;},
  localSnapshot(){
   return localDemoEnabled ? {
     targetRtpBps:localTargetBps,revision:0,source:'RENDER_LOCAL_DEMO',applied:true
   } : {...DEFAULT};
  },
  async snapshot(){
   if(!enabled)return {...DEFAULT};
   const local=env.NODE_ENV!=='production'&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
   if((!base.startsWith('https://')&&!local)||!/^https?:\/\/[^/]+$/.test(base)||
     !/^[A-Za-z0-9_-]{32,256}$/.test(key))throw unavailable('PROVIDER_RTP_NOT_CONFIGURED');
   let response,payload;
   try{
    response=await fetcher(`${base}/api/v1/adapter/rtp/${GAME_ID}`,{
      method:'GET',headers:{'X-Game-Adapter-Key':key,Accept:'application/json'},
      redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)
    });
    const body=await response.text();
    if(body.length>4096)throw unavailable('PROVIDER_RTP_RESPONSE_INVALID');
    payload=JSON.parse(body);
   }catch{throw unavailable('PROVIDER_RTP_UNAVAILABLE');}
   const d=payload?.data;
   if(!response.ok||payload?.ok!==true||d?.gameId!==GAME_ID||
      !Number.isInteger(d.targetRtpBps)||d.targetRtpBps<100||d.targetRtpBps>9900||
      !Number.isSafeInteger(d.revision)||d.revision<0||d.verifiedGameAdapter!==true||
      d.effectiveFrom!=='NEXT_NEW_ROUND')throw unavailable('PROVIDER_RTP_RESPONSE_INVALID');
   return {targetRtpBps:d.targetRtpBps,revision:d.revision,source:'G_PROVIDER',applied:true};
  }
 });
}
export const providerRtp=createProviderRtpClient();

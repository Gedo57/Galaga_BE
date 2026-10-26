/** Reports observed server-side metadata to G Provider. Sandbox QA only.
 * Online numbers must come from actual authenticated game sockets, never bots.
 * Unknown values are null; recent results remain empty until verified by the game engine.
 * Credentials are stored in Render only, never returned or logged. */
export function startGameMetricsReporter({gameId, adapterKeyEnv, minBetCredits, onlinePlayers=()=>null}) {
  if (process.env.GAME_PROVIDER_METRICS_ENABLED !== 'true') return null;
  const key=String(process.env[adapterKeyEnv]||'').trim();
  const base=String(process.env.GAME_PROVIDER_API_URL||'').replace(/\/+$/,'');
  if(!/^https:\/\/[A-Za-z0-9.-]+$/.test(base) || !/^[A-Za-z0-9_-]{32,256}$/.test(key)){
    console.warn('[game-metrics] Disabled: provider URL or server-side key missing');
    return null;
  }
  let busy=false;
  let lastObserved=0;
  const report=async()=>{
    if(busy)return;
    busy=true;
    try{
      const min=Number(typeof minBetCredits==='function'?minBetCredits():NaN);
      const minBetMinor=Number.isFinite(min)&&min>0&&Number.isSafeInteger(Math.round(min*100))
        ? Math.round(min*100):null;
      const observed=Number(typeof onlinePlayers==='function'?onlinePlayers():NaN);
      const online=Number.isSafeInteger(observed)&&observed>=0&&observed<=1000000?observed:null;
      const at=Math.max(Date.now(),lastObserved+1);
      lastObserved=at;
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),5000);timeout.unref?.();
      try{
        const response=await fetch(base+'/api/v1/games/metrics/report',{
          method:'POST',redirect:'error',signal:controller.signal,
          headers:{'Content-Type':'application/json','X-Game-Adapter-Key':key},
          body:JSON.stringify({gameId,observedAt:at,currency:'CREDITS',minBetMinor,onlinePlayers:online,recentResults:[]})
        });
        if(!response.ok)console.warn('[game-metrics] Report rejected for '+gameId+' (HTTP '+response.status+')');
      } finally{clearTimeout(timeout)}
    } catch(error){
      console.warn('[game-metrics] Report unavailable for '+gameId+' ('+(error?.name==='AbortError'?'timeout':'connection/error')+')');
    }finally{busy=false;}
  };
  const first=setTimeout(()=>void report(),5000);first.unref?.();
  const timer=setInterval(()=>void report(),45000);timer.unref?.();
  return ()=>{clearTimeout(first);clearInterval(timer)};
}

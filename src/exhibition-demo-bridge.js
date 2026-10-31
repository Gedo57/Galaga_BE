/** Exhibition-only game adapter. Does NOT modify the existing operator/casino Provider connection.
 * An exhibition launch ticket always uses a separately scoped game-backend key and a
 * pinned, isolated G Provider QA service. All wallet calls stay server-to-server.
 */
const TICKET=/^GPDEMO_[A-Za-z0-9_-]{36}$/;
const ID=/^[A-Za-z0-9_.:-]{8,128}$/;
const ROUND=/^[A-Za-z0-9_.:-]{1,128}$/;
const KEY=/^[A-Za-z0-9_-]{32,256}$/;
const QA_HOST='https://g-provider-api-free.onrender.com';
const fail=(code,status=503)=>{
  const error=new Error(code);error.code=code;error.status=error.statusCode=status;return error;
};
export function createExhibitionGameBridge(gameId,env=process.env){
  const enabled=env.GAME_PROVIDER_EXHIBITION_ENABLED==='true';
  const key=String(env.GAME_PROVIDER_EXHIBITION_KEY||'').trim();
  const host=String(env.GAME_PROVIDER_EXHIBITION_URL||'').trim().replace(/\/+$/,'');
  const dev=env.NODE_ENV!=='production'&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  function ready(){
    if(!enabled||!KEY.test(key)||(host!==QA_HOST&&!dev))
      throw fail('EXHIBITION_GAME_NOT_CONFIGURED');
  }
  async function post(route,body){
    ready();
    let response,data;
    try{
      response=await fetch(host+'/api/v1/'+route,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{'Content-Type':'application/json','X-Game-Adapter-Key':key},
        body:JSON.stringify(body)});
      const raw=await response.text();
      if(raw.length>16384)throw fail('EXHIBITION_RESPONSE_TOO_LARGE',502);
      data=JSON.parse(raw);
    }catch(error){
      if(error.code==='EXHIBITION_RESPONSE_TOO_LARGE')throw error;
      throw fail('EXHIBITION_WALLET_UNAVAILABLE');
    }
    if(!response.ok||data?.ok!==true||!data?.data)
      throw fail(String(data?.error?.code||'EXHIBITION_WALLET_REQUEST_FAILED'),
        response.status===202?503:response.status);
    return data.data;
  }
  function validIdentity(identity){
    const wallet=identity?.providerWallet||identity;
    if(!wallet||typeof wallet.launchId!=='string'||!wallet.launchId.startsWith('demolaunch:')||
      !ID.test(wallet.launchId))throw fail('EXHIBITION_SESSION_INVALID',401);
    return wallet;
  }
  const toMinor=(amount,decimals)=>{
    const scaled=Number(amount)*10**decimals,n=Math.round(scaled);
    if(!Number.isSafeInteger(n)||n<=0||Math.abs(scaled-n)>1e-6)
      throw fail('EXHIBITION_AMOUNT_INVALID',400);
    return n;
  };
  return Object.freeze({
    get enabled(){return enabled;},
    isTicket(token){return String(token||'').startsWith('GPDEMO_');},
    isSession(identity){return typeof (identity?.providerWallet||identity)?.launchId==='string'&&
      (identity.providerWallet||identity).launchId.startsWith('demolaunch:');},
    async consume(token,exchangeId){
      if(!TICKET.test(String(token||''))||!ID.test(String(exchangeId||'')))throw fail('EXHIBITION_TICKET_INVALID',401);
      const result=await post('launch/consume',{gameId,launchToken:token,exchangeId});
      if(result?.environment!=='sandbox'||result?.simulated!==true||result.gameId!==gameId||
         result.integratorId!=='g-provider-demo'||!ID.test(result.launchId||'')||
         result.wallet?.currency!=='USD'||result.wallet?.decimals!==2||
         typeof result.externalPlayerId!=='string')throw fail('EXHIBITION_RESPONSE_INVALID');
      return result;
    },
    async balance(identity){
      const w=validIdentity(identity);
      const result=await post('wallet/balance',{gameId,launchId:w.launchId});
      if(result.currency!=='USD'||!Number.isSafeInteger(result.balanceMinor)||result.balanceMinor<0||
         result.simulated!==true)throw fail('EXHIBITION_BALANCE_INVALID');
      return result;
    },
    async transaction(identity,transactionId){
      const w=validIdentity(identity);
      if(!ID.test(transactionId||''))throw fail('EXHIBITION_TRANSACTION_INVALID',400);
      return post('wallet/transaction',{gameId,launchId:w.launchId,transactionId});
    },
    async operation(identity,action,{roundId,amount,transactionId,betTransactionId}={}){
      const w=validIdentity(identity);
      if(!['bet','win','refund'].includes(action)||!ROUND.test(roundId||'')||
        !ID.test(transactionId||'')||(action!=='bet'&&!ID.test(betTransactionId||'')))
        throw fail('EXHIBITION_OPERATION_INVALID',400);
      const result=await post('wallet/'+action,{gameId,launchId:w.launchId,roundId,transactionId,
        amountMinor:toMinor(amount,2),currency:'USD',
        ...(action==='bet'?{}:{betTransactionId})});
      if(result.transactionId!==transactionId||result.status!=='succeeded')
        throw fail('EXHIBITION_OPERATION_UNCONFIRMED');
      return result;
    }
  });
}

import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { encryptToken, decryptToken } from '../crypto';
import { type Post } from '../domain';
import { AppError, appUrl, db, env, checkDB, requireSubscription, logTechnical } from './core';
import { publishImageUrl } from './images';
const API='https://graph.threads.net';
export class ThreadsError extends Error {constructor(public status:number,public providerCode:number|null,public details?:any){super(`Threads request failed with status ${status}: ${JSON.stringify(details)}`);}}
export async function threadsRequest<T>(path:string,token:string|undefined,params:Record<string,string>={},method='GET'):Promise<T>{
 const url=new URL(`${API}/${path}`);if(method==='GET')Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
 const response=await fetch(url,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:method==='POST'?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(25_000),cache:'no-store'});
 const value=await response.json();if(!response.ok||value.error){console.error('threadsRequest failed:',{status:response.status,body:value});throw new ThreadsError(response.status,value.error?.code||null,value);}return value as T;
}
export async function startThreads(userId:string){
 await requireSubscription(userId);const client=env('META_APP_ID');env('META_APP_SECRET');env('TOKEN_ENCRYPTION_KEY');
 const state=randomBytes(32).toString('hex');const jar=await cookies();jar.set('threads_oauth_state',`${userId}:${state}`,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:600});
 const url=new URL('https://threads.net/oauth/authorize');url.search=new URLSearchParams({client_id:client,redirect_uri:env('THREADS_REDIRECT_URI'),scope:'threads_basic,threads_content_publish',response_type:'code',state}).toString();return {url:url.toString()};
}
export async function finishThreads(req:Request,userId:string){
 const jar=await cookies();const state=jar.get('threads_oauth_state')?.value;jar.delete('threads_oauth_state');const q=new URL(req.url).searchParams;const expected=`${userId}:${q.get('state')||''}`;
 if(!state||state.length!==expected.length||!timingSafeEqual(Buffer.from(state),Buffer.from(expected)))return NextResponse.redirect(`${appUrl()}/connections?error=state`);
 if(q.has('error')||!q.get('code'))return NextResponse.redirect(`${appUrl()}/connections?error=cancelled`);
 try{
  await requireSubscription(userId);
  const short=await threadsRequest<{access_token:string;user_id:string}>('oauth/access_token',undefined,{client_id:env('META_APP_ID'),client_secret:env('META_APP_SECRET'),code:q.get('code')!,grant_type:'authorization_code',redirect_uri:env('THREADS_REDIRECT_URI')},'POST');
  const long=await threadsRequest<{access_token:string;expires_in:number}>('access_token',undefined,{grant_type:'th_exchange_token',client_secret:env('META_APP_SECRET'),access_token:short.access_token});
  const profile=await threadsRequest<{id:string;username:string}>('v1.0/me',long.access_token,{fields:'id,username'});
  if(!profile.id||!profile.username||!long.access_token||!Number.isFinite(long.expires_in))throw new Error('Invalid OAuth response');
   const {data:old,error}=await db().from('social_accounts').select('platform_user_id').eq('user_id',userId).eq('platform','threads').maybeSingle();checkDB(error);
   if(old&&old.platform_user_id!==profile.id)return NextResponse.redirect(`${appUrl()}/connections?error=different_account`);
   const saved=await db().from('social_accounts').upsert({user_id:userId,platform:'threads',platform_user_id:profile.id,username:profile.username,access_token_encrypted:encryptToken(long.access_token,userId,env('TOKEN_ENCRYPTION_KEY')),expires_at:new Date(Date.now()+long.expires_in*1000).toISOString(),status:'connected',updated_at:new Date().toISOString()},{onConflict:'user_id,platform'});checkDB(saved.error);
  return NextResponse.redirect(`${appUrl()}/connections?connected=1`);
 }catch(e){console.error('finishThreads error:',e);await logTechnical(userId,null,'oauth_failed',{type:e instanceof ThreadsError?'provider':'internal',message:(e as Error).message,details:e instanceof ThreadsError?(e as any).details:String(e)});return NextResponse.redirect(`${appUrl()}/connections?error=connection`);}
}
import { processInstagramPublish } from './instagram';

interface PublishPost extends Post {user_id:string;social_account_id:string|null;container_id:string|null;attempts:number;publish_attempted_at:string|null;}
export async function processPost(post:PublishPost){
 let attempted=!!post.publish_attempted_at;let publishedId:string|undefined;
 try{
  await requireSubscription(post.user_id);
  const targetPlatform = post.platform || 'threads';

  if (targetPlatform === 'instagram') {
    publishedId = await processInstagramPublish(post);
    const saved = await db().rpc('complete_publish', { p_id: post.id, p_platform_id: publishedId });
    checkDB(saved.error);
    return;
  }

  const {data:account,error}=await db().from('social_accounts').select('*').eq('user_id',post.user_id).eq('platform','threads').maybeSingle();checkDB(error);
  if(!account||account.status!=='connected'||!account.access_token_encrypted||Date.parse(account.expires_at)<=Date.now())throw new AppError('Sila sambungkan semula akaun Threads anda.',409,'reconnect');
  const token=decryptToken(account.access_token_encrypted,post.user_id,env('TOKEN_ENCRYPTION_KEY'));
  if(attempted)throw new AppError('Hasil penerbitan belum dapat dipastikan.',409,'outcome_unknown');
  let container=post.container_id;
  if(!container){const params:Record<string,string>={media_type:post.image_url?'IMAGE':'TEXT',text:post.caption};if(post.image_url)params.image_url=await publishImageUrl(post.image_url,post.user_id);
   const created=await threadsRequest<{id:string}>(`v1.0/${account.platform_user_id}/threads`,token,params,'POST');if(!created.id)throw new Error('Missing container');container=created.id;
   const save=await db().from('posts').update({container_id:container}).eq('id',post.id).eq('status','publishing');checkDB(save.error);
  }
  let finished = false;
  for (let i = 0; i < 5; i++) {
    const status = await threadsRequest<{status:string;error_message?:string}>(`v1.0/${container}`, token, {fields:'status,error_message'});
    if (status.status === 'FINISHED') {
      finished = true;
      break;
    }
    if (status.status === 'PUBLISHED') throw new AppError('Semak post ini di Threads sebelum mencuba lagi.', 409, 'outcome_unknown');
    if (status.status === 'ERROR') throw new AppError(status.error_message || 'Visual belum boleh diterbitkan. Cuba jana atau muat naik semula.', 502, 'media_failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!finished) {
    if (post.attempts >= 8) throw new AppError('Gambar mengambil masa terlalu lama untuk diproses. Sila cuba semula.', 502, 'media_timeout');
    const save = await db().from('posts').update({status:'scheduled', scheduled_at:post.scheduled_at||new Date().toISOString(), next_attempt_at:new Date(Date.now()+60_000).toISOString(), claimed_at:null}).eq('id',post.id).eq('status','publishing');
    checkDB(save.error);
    return;
  }
  const marker=await db().from('posts').update({publish_attempted_at:new Date().toISOString()}).eq('id',post.id).eq('status','publishing').select('id').single();checkDB(marker.error);
  attempted=true;
  const published=await threadsRequest<{id:string}>(`v1.0/${account.platform_user_id}/threads_publish`,token,{creation_id:container},'POST');
  if(!published.id)throw new Error('Missing publish result');publishedId=published.id;

  if (targetPlatform === 'both') {
    try {
      const igId = await processInstagramPublish(post);
      publishedId = `${published.id},${igId}`;
    } catch (igErr) {
      await logTechnical(post.user_id, post.id, 'instagram_cross_publish_failed', { threads_id: published.id, error: (igErr as Error).message });
    }
  }

  const saved=await db().rpc('complete_publish',{p_id:post.id,p_platform_id:publishedId});checkDB(saved.error);
 }catch(e){
  const unknown=attempted||e instanceof AppError&&e.code==='outcome_unknown';
  const reconnect=e instanceof ThreadsError&&(e.providerCode===190||e.status===401)||e instanceof AppError&&(e.code==='reconnect'||e.code==='reconnect_instagram');
  if(reconnect){await db().from('social_accounts').update({status:'reconnect'}).eq('user_id',post.user_id);}
  const message=unknown?'Hasil penerbitan belum pasti. Semak akaun sosial dan hubungi pentadbir sebelum mencuba lagi.':reconnect?'Post gagal diterbitkan. Sila sambungkan semula akaun anda.':e instanceof AppError?e.message:'Post gagal diterbitkan. Sila cuba lagi sebentar.';
  await db().from('posts').update({status:'failed',error_message:message,error_code:unknown?'outcome_unknown':reconnect?'reconnect':e instanceof AppError?e.code:'publish_failed',...(unknown?{}:{container_id:null,publish_attempted_at:null}),updated_at:new Date().toISOString()}).eq('id',post.id).eq('status','publishing');
  await logTechnical(post.user_id,post.id,'publish_failed',{unknown,platform_post_id:publishedId||null,provider_code:e instanceof ThreadsError?e.providerCode:null});
 }
}
export async function runDuePosts(){const {data,error}=await db().rpc('claim_due_posts',{p_limit:4});checkDB(error);await Promise.all((data||[]).map((p:PublishPost)=>processPost(p)));return {processed:data?.length||0};}
export async function publishNow(userId:string,postId:string){await requireSubscription(userId);const {data,error}=await db().rpc('claim_post',{p_id:postId,p_user:userId});checkDB(error);if(!data?.[0])throw new AppError('Post sedang diterbitkan atau tidak boleh diterbitkan semula.',409);await processPost(data[0]);}
export async function refreshTokens(){
 const client=db();const {data,error}=await client.from('social_accounts').select('id,user_id,access_token_encrypted,expires_at').eq('status','connected').lt('expires_at',new Date(Date.now()+7*86400_000).toISOString()).limit(50);checkDB(error);
 let refreshed=0;
 for(const a of data||[]){try{if(Date.parse(a.expires_at)<=Date.now())throw new Error('Expired');const token=decryptToken(a.access_token_encrypted,a.user_id,env('TOKEN_ENCRYPTION_KEY'));const next=await threadsRequest<{access_token:string;expires_in:number}>('refresh_access_token',token,{grant_type:'th_refresh_token'});if(!next.access_token||!Number.isFinite(next.expires_in))throw new Error('Invalid refresh');const saved=await client.from('social_accounts').update({access_token_encrypted:encryptToken(next.access_token,a.user_id,env('TOKEN_ENCRYPTION_KEY')),expires_at:new Date(Date.now()+next.expires_in*1000).toISOString(),updated_at:new Date().toISOString()}).eq('id',a.id);checkDB(saved.error);refreshed++;}catch{await client.from('social_accounts').update({status:'reconnect'}).eq('id',a.id);await logTechnical(a.user_id,null,'token_refresh_failed');}}
 await client.from('rate_limits').delete().lt('window_start',new Date(Date.now()-86400_000).toISOString());
 // Interrupted generation requests retain their reservation pending cost reconciliation.
 await client.from('generations').update({status:'uncertain'}).eq('status','reserved').lt('created_at',new Date(Date.now()-15*60_000).toISOString());
 return {refreshed};
}

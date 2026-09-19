import { z } from 'zod';
import { type Post, postSchema, generationSchema, scheduledUTC, timezoneSchema, editable } from '@/lib/domain';
import { mediaPath } from '@/lib/media';
import { AppError,adminAllowed,checkDB,cronAuth,db,ensureProfile,errorResponse,json,jsonBody,rate,requireAdmin,requireSubscription,requireUser,sameOrigin } from '@/lib/server/core';
import { generate,models } from '@/lib/server/ai';
import { checkout,paymentWebhook,portal } from '@/lib/server/billing';
import { finishThreads,publishNow,refreshTokens,runDuePosts,startThreads } from '@/lib/server/threads';
import { finishInstagram,startInstagram } from '@/lib/server/instagram';
import { storeImage } from '@/lib/server/images';

export const runtime='nodejs';
export const maxDuration=240;
const fields='id,title,caption,image_url,image_prompt,timezone,platform,status,scheduled_at,published_at,created_at,updated_at,platform_post_id,error_message,error_code';
type Context={params:Promise<{path:string[]}>};
async function ownPost(id:string,user:string){z.uuid().parse(id);const {data,error}=await db().from('posts').select(fields).eq('id',id).eq('user_id',user).maybeSingle();checkDB(error);if(!data)throw new AppError('Post tidak ditemui.',404);return data as Post;}
async function ownAccount(user:string,platform:'threads'|'instagram'='threads'){const {data,error}=await db().from('social_accounts').select('id,username,status,expires_at').eq('user_id',user).eq('platform',platform).maybeSingle();checkDB(error);if(!data||data.status!=='connected'||!data.expires_at||Date.parse(data.expires_at)<=Date.now())throw new AppError(`Sambungkan akaun ${platform==='threads'?'Threads':'Instagram'} dahulu.`,409);return data;}
function mutable(post:Post){if(!editable(post))throw new AppError('Post sedang atau telah diterbitkan, atau memerlukan semakan pentadbir.',409);}
async function allPosts(user:string){
 const rows:Post[]=[];let offset=0;
 for(;;){const {data,error}=await db().from('posts').select(fields).eq('user_id',user).order('updated_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+999);checkDB(error);rows.push(...(data||[]) as Post[]);if(!data||data.length<1000)break;offset+=1000;}
 return rows;
}
async function handle(req:Request,context:Context){try{
 const {path}=await context.params;const route=path.join('/');const method=req.method;
 if(method==='GET'&&route==='health'){
  const started=Date.now();const client=db();const {error}=await client.from('plans').select('id',{count:'exact',head:true}).eq('active',true);checkDB(error);
  return json({status:'ok',database:'ok',timestamp:new Date().toISOString(),latency_ms:Date.now()-started});
 }
 if(method==='POST'&&route==='webhooks/payment')return json(await paymentWebhook(req));
 if(method==='GET'&&route.startsWith('cron/')){cronAuth(req);if(route==='cron/publish')return json(await runDuePosts());if(route==='cron/refresh')return json(await refreshTokens());throw new AppError('Not found',404);}
 if(['POST','PATCH','DELETE'].includes(method))sameOrigin(req);
 const user=await requireUser();await ensureProfile(user);
 if(method==='GET'&&route==='auth/threads/callback')return await finishThreads(req,user.id);
 if(method==='GET'&&route==='auth/instagram/callback')return await finishInstagram(req,user.id);
 if(method==='GET'&&route==='media'){
  let stored:string;try{stored=mediaPath(`/api/media?path=${encodeURIComponent(new URL(req.url).searchParams.get('path')||'')}`,user.id);}catch{throw new AppError('Gambar tidak ditemui.',404);}
  const {data,error}=await db().storage.from('post-images').download(stored);checkDB(error);if(!data)throw new AppError('Gambar tidak ditemui.',404);
  return new Response(data,{headers:{'Content-Type':data.type,'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'}});
 }
 if(method==='GET'&&(route==='workspace'||route==='usage')){
  const client=db();const month=new Date().toISOString().slice(0,7)+'-01';
  const [profile,threadsAcc,igAcc,subscription,usage,plans]=await Promise.all([client.from('users').select('name,email,timezone,language').eq('id',user.id).single(),client.from('social_accounts').select('id,username,status,expires_at,platform').eq('user_id',user.id).eq('platform','threads').maybeSingle(),client.from('social_accounts').select('id,username,status,expires_at,platform').eq('user_id',user.id).eq('platform','instagram').maybeSingle(),client.from('subscriptions').select('plan_id,status,current_period_end,cancel_at_period_end').eq('user_id',user.id).maybeSingle(),client.from('usage').select('copy_generations,image_generations,posts_published,estimated_cost').eq('user_id',user.id).eq('month',month).maybeSingle(),client.from('plans').select('*').order('monthly_price')]);
  [profile,threadsAcc,igAcc,subscription,usage,plans].forEach(result=>checkDB(result.error));
  const usageData=usage.data||{copy_generations:0,image_generations:0,posts_published:0,estimated_cost:0};
  if(route==='usage')return json(usageData);
  return json({profile:profile.data,account:threadsAcc.data,instagramAccount:igAcc.data,accounts:{threads:threadsAcc.data,instagram:igAcc.data},subscription:subscription.data,usage:usageData,plans:plans.data,posts:await allPosts(user.id),isAdmin:adminAllowed(user.id)});
 }
 if(method==='GET'&&route==='posts')return json(await allPosts(user.id));
 if(method==='GET'&&path[0]==='posts'&&path.length===2)return json(await ownPost(path[1],user.id));
 if(method==='POST'&&route==='posts'){
  await rate(user.id,'posts',30);const input=postSchema.parse(await jsonBody(req));if(input.image_url)mediaPath(input.image_url,user.id);
  const {data,error}=await db().from('posts').insert({...input,user_id:user.id}).select(fields).single();checkDB(error);return json(data,201);
 }
 if(path[0]==='posts'&&path[1]&&path.length<=3){
  const post=await ownPost(path[1],user.id);mutable(post);await rate(user.id,'posts',30);
  if(method==='PATCH'&&path.length===2){
   const input=postSchema.parse(await jsonBody(req));if(input.image_url)mediaPath(input.image_url,user.id);if(post.status==='scheduled'&&!input.caption.trim())throw new AppError('Post berjadual memerlukan caption.');
   const {data,error}=await db().from('posts').update({...input,container_id:null,publish_attempted_at:null,error_message:null,error_code:null,updated_at:new Date().toISOString()}).eq('id',post.id).eq('user_id',user.id).eq('updated_at',post.updated_at).in('status',['draft','scheduled','failed']).select(fields).maybeSingle();checkDB(error);if(!data)throw new AppError('Post telah berubah. Muat semula sebelum menyunting.',409);return json(data);
  }
  if(method==='DELETE'&&path.length===2){const {data,error}=await db().from('posts').delete().eq('id',post.id).eq('user_id',user.id).eq('updated_at',post.updated_at).in('status',['draft','scheduled','failed']).select('id');checkDB(error);if(!data?.length)throw new AppError('Post telah berubah. Muat semula.',409);return json({deleted:true});}
  if(method==='POST'&&path[2]==='schedule'){
   await requireSubscription(user.id);
   const targetPlatform=post.platform||'threads';
   if(targetPlatform==='threads'||targetPlatform==='both')await ownAccount(user.id,'threads');
   if(targetPlatform==='instagram'||targetPlatform==='both'){
    await ownAccount(user.id,'instagram');
    if(!post.image_url)throw new AppError('Post ke Instagram memerlukan gambar.');
   }
   const input=z.object({local:z.string(),timezone:timezoneSchema}).parse(await jsonBody(req));if(!post.caption.trim())throw new AppError('Caption diperlukan sebelum menjadualkan.');let date:string;try{date=scheduledUTC(input.local,input.timezone);}catch(e){throw new AppError((e as Error).message);}
   const {data,error}=await db().from('posts').update({status:'scheduled',scheduled_at:date,timezone:input.timezone,container_id:null,publish_attempted_at:null,next_attempt_at:null,attempts:0,error_message:null,error_code:null,updated_at:new Date().toISOString()}).eq('id',post.id).eq('user_id',user.id).eq('updated_at',post.updated_at).in('status',['draft','scheduled','failed']).select(fields).maybeSingle();checkDB(error);if(!data)throw new AppError('Post telah berubah. Muat semula.',409);return json(data);
  }
  if(method==='POST'&&path[2]==='publish'){
   await rate(user.id,'publish',6);await requireSubscription(user.id);
   const targetPlatform=post.platform||'threads';
   if(targetPlatform==='threads'||targetPlatform==='both')await ownAccount(user.id,'threads');
   if(targetPlatform==='instagram'||targetPlatform==='both'){
    await ownAccount(user.id,'instagram');
    if(!post.image_url)throw new AppError('Post ke Instagram memerlukan gambar.');
   }
   if(!post.caption.trim())throw new AppError('Caption diperlukan sebelum penerbitan.');
   const saved=await db().from('posts').update({updated_at:new Date().toISOString()}).eq('id',post.id).eq('user_id',user.id).eq('updated_at',post.updated_at).in('status',['draft','scheduled','failed']).select('id').maybeSingle();checkDB(saved.error);if(!saved.data)throw new AppError('Post telah berubah. Muat semula.',409);
   await publishNow(user.id,post.id);return json(await ownPost(post.id,user.id));
  }
 }
 if(method==='POST'&&route==='ai/copy'){await rate(user.id,'ai',6);const input=generationSchema.parse(await jsonBody(req));return json(await generate(user.id,'copy',input));}
 if(method==='POST'&&route==='ai/image'){await rate(user.id,'ai',6);const input=z.object({prompt:z.string().trim().min(3).max(3000),post_id:z.uuid().optional()}).parse(await jsonBody(req));return json(await generate(user.id,'image',input));}
 if(method==='POST'&&route==='uploads'){
  await rate(user.id,'upload',10);await requireSubscription(user.id);if(Number(req.headers.get('content-length')||0)>4_300_000)throw new AppError('Gambar maksimum 4 MB.',413);
  const form=await req.formData();const file=form.get('file');if(!(file instanceof File)||file.size>4*1024*1024)throw new AppError('Pilih gambar maksimum 4 MB.',413);return json({image_url:await storeImage(Buffer.from(await file.arrayBuffer()),user.id)});
 }
 if(method==='GET'&&route==='auth/threads'){await rate(user.id,'oauth',6);return json(await startThreads(user.id));}
 if(method==='POST'&&route==='auth/threads/disconnect'){const {error}=await db().from('social_accounts').update({status:'disconnected',access_token_encrypted:null,expires_at:null,updated_at:new Date().toISOString()}).eq('user_id',user.id).eq('platform','threads');checkDB(error);return json({disconnected:true});}
 if(method==='GET'&&route==='auth/instagram'){await rate(user.id,'oauth',6);return json(await startInstagram(user.id));}
 if(method==='POST'&&route==='auth/instagram/disconnect'){const {error}=await db().from('social_accounts').update({status:'disconnected',access_token_encrypted:null,expires_at:null,updated_at:new Date().toISOString()}).eq('user_id',user.id).eq('platform','instagram');checkDB(error);return json({disconnected:true});}
 if(method==='POST'&&route==='billing/checkout'){await rate(user.id,'billing',5);const input=z.object({plan_id:z.enum(['starter','pro','business'])}).parse(await jsonBody(req));return json(await checkout(user.id,user.email||'',input.plan_id));}
 if(method==='POST'&&route==='billing/portal'){await rate(user.id,'billing',5);return json(await portal(user.id));}
 if(method==='PATCH'&&route==='settings'){const profile=z.object({name:z.string().trim().min(1).max(80),timezone:timezoneSchema,language:z.enum(['Bahasa Melayu','English'])}).parse(await jsonBody(req));const {error}=await db().from('users').update({...profile,updated_at:new Date().toISOString()}).eq('id',user.id);checkDB(error);return json(profile);}
 if(method==='DELETE'&&route==='account'){
  const client=db();
  for(;;){const listed=await client.storage.from('post-images').list(user.id,{limit:100});checkDB(listed.error);if(!listed.data?.length)break;const removed=await client.storage.from('post-images').remove(listed.data.map(file=>`${user.id}/${file.name}`));checkDB(removed.error);}
  const deleted=await client.auth.admin.deleteUser(user.id);checkDB(deleted.error);return json({deleted:true});
 }
 if(path[0]==='admin'){
  requireAdmin(user.id);
  if(method==='GET'&&route==='admin'){
   const mon=new Date().toISOString().slice(0,7)+'-01';const c=db();const [users,subscriptions,usage,published,failed,plans,settings]=await Promise.all([c.from('users').select('*',{count:'exact',head:true}),c.from('subscriptions').select('plan_id').eq('status','active').gt('current_period_end',new Date().toISOString()),c.from('usage').select('image_generations,estimated_cost').eq('month',mon),c.from('posts').select('*',{count:'exact',head:true}).eq('status','published'),c.from('posts').select('*',{count:'exact',head:true}).eq('status','failed'),c.from('plans').select('*').order('monthly_price'),models()]);[users,subscriptions,usage,published,failed,plans].forEach(v=>checkDB(v.error));return json({users:users.count,subscribers:subscriptions.data?.length||0,mrr:(subscriptions.data||[]).reduce((sum,s)=>sum+Number(plans.data?.find(p=>p.id===s.plan_id)?.monthly_price||0),0),aiCost:(usage.data||[]).reduce((sum,u)=>sum+Number(u.estimated_cost),0)*Number(process.env.USD_MYR_RATE||4.5),images:(usage.data||[]).reduce((sum,u)=>sum+u.image_generations,0),published:published.count,failed:failed.count,infra:Number(process.env.MONTHLY_INFRA_COST_MYR||0),plans:plans.data,settings});
  }
  if(method==='PATCH'&&route==='admin/settings'){const input=z.object({copy_model:z.string().regex(/^[a-zA-Z0-9._:/-]{3,120}$/),image_model:z.string().regex(/^[a-zA-Z0-9._:/-]{3,120}$/)}).parse(await jsonBody(req));const result=await db().from('app_settings').upsert({id:true,...input});checkDB(result.error);return json(input);}
  if(method==='PATCH'&&path[1]==='plans'&&path.length===3){const input=z.object({monthly_price:z.number().min(0).max(10000),monthly_post_limit:z.number().int().min(0).max(100000),monthly_image_limit:z.number().int().min(0).max(100000),active:z.boolean()}).parse(await jsonBody(req));const result=await db().from('plans').update(input).eq('id',path[2]).select('*').single();checkDB(result.error);return json(result.data);}
 }
 throw new AppError('Endpoint tidak ditemui.',404);
}catch(e){return await errorResponse(e);}}
export const GET=handle;export const POST=handle;export const PATCH=handle;export const DELETE=handle;
